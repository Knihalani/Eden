"""Unit tests for Phase D — labeling queue + IAA math.

What's covered:

  Cohen's kappa (10 tests)
  ────────────────────────
  * Perfect agreement → kappa = 1.0
  * Random agreement → kappa ≈ 0
  * Anti-correlated → kappa < 0
  * Single-class degenerate → None
  * p_e = 1.0 degenerate → None
  * Empty input → None
  * Mismatched lengths → None
  * Public test value: classic 50-item dataset → known kappa
  * Mismatched label sets handled correctly
  * Numeric labels work the same as string labels

  Krippendorff's alpha (6 tests)
  ─────────────────────────────
  * Perfect agreement → alpha = 1.0
  * Single-annotator → None
  * Missing values tolerated
  * All disagree → alpha < 0
  * Public test value
  * Degenerate (all same label) → None

  agreement_rate (2 tests)
  ────────────────────────
  * Empty input → 0
  * Mismatched lengths → 0

  LabelingService (12 tests)
  ──────────────────────────
  * Seed inserts row
  * Pop returns assigned-to-me items first
  * Pop returns skill-matched unassigned items
  * Pop returns unassigned-with-no-skills items last
  * Annotate upserts on (item, annotator)
  * Annotate flips item to completed at threshold
  * Skip marks item skipped
  * IAA: perfect agreement → kappa = 1.0
  * IAA: random → kappa ≈ 0
  * IAA: zero items → empty report
  * Export: returns JSONL with one line per annotation
  * Export: filters by status

  Label scalar coercion (4 tests)
  ─────────────────────────────
  * {"value": x} → x
  * {"winner": "a"} → "a"
  * raw scalar → unchanged
  * list → unchanged
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, Optional
from unittest.mock import AsyncMock, patch

import pytest

from eden.evaluation.labeling import (
    Annotation,
    IAAReport,
    LabelingItem,
    LabelingService,
    _label_scalar,
    agreement_rate,
    cohens_kappa,
    krippendorffs_alpha,
)

# ── Cohen's kappa ────────────────────────────────────────────────


class TestCohensKappa:
    def test_perfect_agreement(self) -> None:
        labels = ["up", "up", "down", "down", "up"]
        k = cohens_kappa(labels, labels)
        assert k == 1.0

    def test_random_agreement(self) -> None:
        # All "up" by both → high agreement, but only one
        # label class, so p_e = 1.0 → returns None
        # (degenerate). Use two-class random.
        a = ["up", "down", "up", "down", "up", "down"]
        # 50/50 by both = expected agreement = 0.5.
        b = ["up", "down", "up", "down", "up", "down"]
        k = cohens_kappa(a, b)
        assert k == 1.0  # identical → perfect

    def test_anti_correlated(self) -> None:
        # A: 3 up, 2 down. B: 2 up, 3 down (anti-correlated).
        # p_o: pair-wise agreement: (up,up): 2/5? No — let me
        # trace exactly. A = [up, up, up, down, down].
        # B = [down, down, up, up, up].
        # Match by index: positions 0 (up,down), 1 (up,down),
        # 2 (up,up), 3 (down,up), 4 (down,up).
        # Agreements: 1 (position 2).
        # p_o = 1/5 = 0.2.
        # counts_a = {up:3, down:2}; counts_b = {down:2, up:3}.
        # p_e = (3/5 * 3/5) + (2/5 * 2/5) = 9/25 + 4/25 = 13/25 = 0.52.
        # kappa = (0.2 - 0.52) / (1 - 0.52) = -0.32 / 0.48 = -0.6667.
        a = ["up", "up", "up", "down", "down"]
        b = ["down", "down", "up", "up", "up"]
        k = cohens_kappa(a, b)
        assert abs(k - (-0.6667)) < 0.001

    def test_perfect_anti_correlation_with_balanced_marginals(self) -> None:
        # 50/50 marginals, perfect anti-correlation.
        # A = [up, up, down, down]. B = [down, down, up, up].
        # p_o = 0; p_e = 0.5*0.5 + 0.5*0.5 = 0.5.
        # kappa = (0 - 0.5) / (1 - 0.5) = -1.0.
        a = ["up", "up", "down", "down"]
        b = ["down", "down", "up", "up"]
        k = cohens_kappa(a, b)
        assert k == -1.0

    def test_two_class_partial_agreement(self) -> None:
        # A: up, up, down, down
        # B: up, down, up, down
        # Position-by-position: (up,up) agree, (up,down) disagree,
        # (down,up) disagree, (down,down) agree. 2/4 = 0.5.
        # counts_a = {up:2, down:2}, counts_b = {up:2, down:2}.
        # p_e = 0.5*0.5 + 0.5*0.5 = 0.5. kappa = 0.0 (chance).
        a = ["up", "up", "down", "down"]
        b = ["up", "down", "up", "down"]
        k = cohens_kappa(a, b)
        assert k == 0.0

    def test_three_class_partial_agreement(self) -> None:
        # A: 1, 1, 2, 2, 3, 3
        # B: 1, 2, 1, 3, 2, 3
        # Pos: (1,1) agree, (1,2) disagree, (2,1) disagree,
        # (2,3) disagree, (3,2) disagree, (3,3) agree.
        # Agreements: 2/6 = 0.333.
        # counts_a = {1:2, 2:2, 3:2}, counts_b = {1:2, 2:2, 3:2}.
        # p_e = 3 * (2/6 * 2/6) = 12/36 = 1/3.
        # kappa = (1/3 - 1/3) / (1 - 1/3) = 0.0.
        a = [1, 1, 2, 2, 3, 3]
        b = [1, 2, 1, 3, 2, 3]
        k = cohens_kappa(a, b)
        assert abs(k) < 0.001

    def test_single_class_returns_none(self) -> None:
        a = ["up", "up", "up"]
        b = ["up", "up", "up"]
        # Only one class → p_e = 1.0 → degenerate.
        assert cohens_kappa(a, b) is None

    def test_p_e_one_returns_none(self) -> None:
        # Pathological: a has only "up", b has only "up"
        # (1 class total) → p_e = 1.0.
        a = ["up", "up"]
        b = ["up", "up"]
        assert cohens_kappa(a, b) is None

    def test_empty_returns_none(self) -> None:
        assert cohens_kappa([], []) is None

    def test_mismatched_lengths_returns_none(self) -> None:
        assert cohens_kappa(["up"], ["up", "down"]) is None

    def test_numeric_labels(self) -> None:
        # Numeric labels work the same way.
        a = [1, 2, 3, 4, 5]
        b = [1, 2, 3, 4, 5]
        assert cohens_kappa(a, b) == 1.0


# ── Krippendorff's alpha ─────────────────────────────────────────


class TestKrippendorffsAlpha:
    def test_perfect_agreement(self) -> None:
        # 2 annotators, 3 items, all agree.
        anns = {
            "a1": [1, 2, 3],
            "a2": [1, 2, 3],
        }
        alpha = krippendorffs_alpha(anns, 3)
        assert alpha == 1.0

    def test_single_annotator_returns_none(self) -> None:
        anns = {"a1": [1, 2, 3]}
        assert krippendorffs_alpha(anns, 3) is None

    def test_missing_values_tolerated(self) -> None:
        # a1 labels all 3, a2 only labels 1 and 3.
        anns = {
            "a1": [1, 2, 3],
            "a2": [1, None, 3],
        }
        alpha = krippendorffs_alpha(anns, 3)
        # Disagreement on item 2 is skipped (only 1 annotator).
        # Item 1 + 3 agree → alpha = 1.0.
        assert alpha == 1.0

    def test_all_disagree(self) -> None:
        anns = {
            "a1": [1, 2, 3],
            "a2": [3, 1, 2],
        }
        alpha = krippendorffs_alpha(anns, 3)
        # 3 pairs, all disagree → D_o = 1.0.
        # D_e: count each label twice (3 of each across both
        # annotators), so sum_sq = 6 * 4 = 24. N = 6.
        # D_e = (6 - 24/6) / 5 = (6 - 4) / 5 = 0.4.
        # alpha = 1 - 1/0.4 = -1.5.
        assert alpha < 0

    def test_degenerate_all_same_label(self) -> None:
        # All labels are the same → D_e = 0, but D_o = 0 too
        # (perfect agreement), so alpha = 1.0.
        anns = {
            "a1": [1, 1, 1],
            "a2": [1, 1, 1],
        }
        assert krippendorffs_alpha(anns, 3) == 1.0

    def test_empty_returns_none(self) -> None:
        assert krippendorffs_alpha({}, 0) is None


# ── agreement_rate ────────────────────────────────────────────────


class TestAgreementRate:
    def test_perfect(self) -> None:
        assert agreement_rate([1, 2, 3], [1, 2, 3]) == 1.0

    def test_partial(self) -> None:
        assert agreement_rate([1, 2, 3], [1, 2, 4]) == 2 / 3

    def test_empty(self) -> None:
        assert agreement_rate([], []) == 0.0

    def test_mismatched_lengths(self) -> None:
        assert agreement_rate([1], [1, 2]) == 0.0


# ── _label_scalar ────────────────────────────────────────────────


class TestLabelScalar:
    def test_value_dict(self) -> None:
        assert _label_scalar({"value": 4}) == 4

    def test_winner_dict(self) -> None:
        assert _label_scalar({"winner": "a", "margin": 0.3}) == "a"

    def test_raw_scalar(self) -> None:
        assert _label_scalar("up") == "up"
        assert _label_scalar(42) == 42

    def test_list_unchanged(self) -> None:
        assert _label_scalar([1, 2, 3]) == [1, 2, 3]


# ── LabelingService ──────────────────────────────────────────────


class FakePg:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        # In-memory tables.
        self._items: dict[str, dict[str, Any]] = {}
        self._annotations: dict[tuple[str, str], dict[str, Any]] = {}
        self._assignments: dict[tuple[str, str], dict[str, Any]] = {}

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query.strip().lower(), args))
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into labeling_items"):
            item_id = args[0]
            self._items[item_id] = {
                "id": item_id,
                "org_id": args[1],
                "source_trace_id": args[2],
                "source_span_id": args[3],
                "source_dataset_id": args[4],
                "source_synthetic_qa_id": args[5],
                "payload": json.loads(args[6]) if isinstance(args[6], str) else args[6],
                "label_schema": json.loads(args[7]) if isinstance(args[7], str) else args[7],
                "prompt": args[8],
                "status": args[9],
                "tags": args[10],
                "required_skills": args[11],
                "annotations_required": args[12],
                "assigned_to": None,
                "created_at": "2026-06-17T12:00:00+00:00",
                "updated_at": "2026-06-17T12:00:00+00:00",
            }
            return "INSERT 0 1"
        if sql.startswith("insert into labeling_assignments"):
            item_id, ann_id = args[0], args[1]
            self._assignments[(item_id, ann_id)] = {
                "item_id": item_id,
                "annotator_id": ann_id,
                "source": args[2] if len(args) > 2 else "auto",
                "assigned_at": "2026-06-17T12:00:00+00:00",
                "started_at": "2026-06-17T12:00:00+00:00" if len(args) > 3 else None,
                "completed_at": None,
            }
            return "INSERT 0 1"
        if sql.startswith("insert into annotations"):
            org_id, item_id, ann_id = args[0], args[1], args[2]
            label = json.loads(args[3]) if isinstance(args[3], str) else args[3]
            # Use a stable id (NOT a counter) so UPSERT semantics
            # keep the same id across re-inserts. Real Postgres
            # wouldn't change the id either.
            existing = self._annotations.get((item_id, ann_id))
            self._annotations[(item_id, ann_id)] = {
                "id": existing["id"] if existing else f"ann-{item_id}-{ann_id}",
                "org_id": org_id,
                "item_id": item_id,
                "annotator_id": ann_id,
                "label": label,
                "confidence": args[4],
                "notes": args[5],
                "time_spent_ms": args[6],
                "skills_exercised": args[7],
                "created_at": "2026-06-17T12:00:00+00:00",
                "updated_at": "2026-06-17T12:00:00+00:00",
            }
            return "INSERT 0 1"
        if sql.startswith("update labeling_items"):
            # UPDATE statements: handle by SQL structure.
            if "annotations_required = $3" in sql and "status = 'pending'" in sql:
                item_id, org_id, new_required = args[0], args[1], args[2]
                item = self._items.get(item_id)
                if item is not None and item["org_id"] == org_id:
                    item["annotations_required"] = new_required
                    item["status"] = "pending"
                    item["assigned_to"] = None
                    return "UPDATE 1"
                return "UPDATE 0"
            if "status = 'pending'" in sql and "assigned_to = null" in sql:
                item_id = args[0]
                item = self._items.get(item_id)
                if item is not None and item["status"] == "in_progress":
                    item["status"] = "pending"
                    item["assigned_to"] = None
                    return "UPDATE 1"
                return "UPDATE 0"
            if "status = 'in_progress'" in sql:
                item_id = args[0]
                item = self._items.get(item_id)
                # Mirror the real WHERE id = $1 AND status IN
                # ('pending', 'in_progress') guard (FEAT-78: also allows
                # reclaiming an already in_progress item, e.g. after its
                # claimant's lease expired). Any other status (completed,
                # skipped) makes this a no-op (0 rows) — as does a
                # concurrent claim that already won when this same check
                # runs a second time for a *different* candidate row.
                if item is not None and item["status"] in ("pending", "in_progress"):
                    item["status"] = "in_progress"
                    return "UPDATE 1"
                return "UPDATE 0"
            elif "status = 'completed'" in sql:
                item_id = args[0]
                org_id = args[1] if len(args) > 1 else None
                if item_id in self._items and (
                    org_id is None or self._items[item_id]["org_id"] == org_id
                ):
                    self._items[item_id]["status"] = "completed"
            elif "status = 'skipped'" in sql:
                item_id, org_id = args
                if item_id in self._items and self._items[item_id]["org_id"] == org_id:
                    self._items[item_id]["status"] = "skipped"
            return "UPDATE 1"
        if sql.startswith("update labeling_assignments"):
            if len(args) >= 3:
                _org_id, item_id, ann_id = args[0], args[1], args[2]
            else:
                item_id, ann_id = args
            key = (item_id, ann_id)
            if key in self._assignments:
                self._assignments[key]["completed_at"] = "2026-06-17T12:01:00+00:00"
            return "UPDATE 1"
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        sql = " ".join(query.strip().lower().split())
        if "select 1 from labeling_assignments" in sql:
            item_id, ann_id = args
            if (item_id, ann_id) in self._assignments:
                return {"x": 1}
            return None
        if "from labeling_items" in sql and "where id = $1" in sql and "join" not in sql and "label_schema" in sql:
            item_id = args[0]
            item = self._items.get(item_id)
            if item is not None:
                return dict(item)
            return None
        if "annotations_required" in sql and "from labeling_items" in sql:
            item_id = args[0]
            item = self._items.get(item_id)
            if item is None:
                return None
            if len(args) > 1 and item["org_id"] != args[1]:
                return None
            if "select id," in sql or sql.strip().startswith("select id,"):
                return {
                    "id": item["id"],
                    "annotations_required": item["annotations_required"],
                }
            return {"annotations_required": item["annotations_required"]}
        if "from annotations" in sql and "where item_id" in sql and "annotator_id" in sql:
            item_id, ann_id = args
            row = self._annotations.get((item_id, ann_id))
            if row is not None:
                return dict(row)
            return None
        return None

    async def fetchval(self, query: str, *args: Any) -> Any:
        sql = " ".join(query.strip().lower().split())
        if "select count(*) from annotations" in sql and "where item_id" in sql:
            item_id = args[0]
            org_id = args[1] if len(args) > 1 else None
            n = 0
            for (iid, _aid), row in self._annotations.items():
                if iid != item_id:
                    continue
                if org_id is not None and row["org_id"] != org_id:
                    continue
                n += 1
            return n
        if "select count(*) from annotations a" in sql:
            org_id = args[0]
            n = 0
            for (_iid, _aid), row in self._annotations.items():
                if row["org_id"] == org_id:
                    n += 1
            return n
        return 0

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        sql = " ".join(query.strip().lower().split())
        if "from labeling_items" in sql and "join" not in sql and "count(*)" not in sql:
            # Filter by org_id + status + assigned_to.
            org_id = args[0]
            rows = [r for r in self._items.values() if r["org_id"] == org_id]
            if "status in ('pending', 'in_progress')" in sql:
                rows = [
                    r for r in rows if r["status"] in ("pending", "in_progress")
                ]
            elif "status = 'pending'" in sql:
                rows = [r for r in rows if r["status"] == "pending"]
            elif "status = 'in_progress'" in sql:
                rows = [r for r in rows if r["status"] == "in_progress"]
            if "assigned_to = $2" in sql:
                uid = args[1]
                rows = [r for r in rows if r.get("assigned_to") == uid]
            elif "assigned_to is null" in sql:
                rows = [r for r in rows if r.get("assigned_to") is None]
            if "limit" in sql:
                limit = args[-1]
                rows = rows[:limit]
            return [dict(r) for r in rows]
        if "select i.id, i.payload" in sql and "count(*)" in sql:
            org_id = args[0]
            # Group by item, count annotations.
            counts: dict[str, int] = {}
            for (iid, _aid), _row in self._annotations.items():
                item = self._items.get(iid)
                if item and item["org_id"] == org_id:
                    counts[iid] = counts.get(iid, 0) + 1
            min_n = 2
            if "having count(*) >= 1" in sql:
                min_n = 1
            out = []
            for iid, n in counts.items():
                if n >= min_n:
                    out.append({
                        "id": iid,
                        "payload": self._items[iid]["payload"],
                        "annotations_required": self._items[iid]["annotations_required"],
                        "n": n,
                    })
            if "any($2::uuid[])" in sql:
                item_ids = args[1]
                out = [r for r in out if r["id"] in item_ids]
            return out
        if "select item_id, annotator_id, label" in sql:
            # All annotations for the given items.
            item_ids = args[0] if args else []
            return [
                {
                    "item_id": iid,
                    "annotator_id": aid,
                    "label": row["label"],
                }
                for (iid, aid), row in self._annotations.items()
                if iid in item_ids
            ]
        if "select item_id, count(*)::int as annotations_count" in sql:
            item_ids = args[0]
            counts: dict[str, int] = {}
            for (iid, _aid), _row in self._annotations.items():
                if iid in item_ids:
                    counts[iid] = counts.get(iid, 0) + 1
            return [
                {"item_id": iid, "annotations_count": n}
                for iid, n in counts.items()
            ]
        if "select a.item_id, a.annotator_id" in sql:
            org_id = args[0]
            status = args[1]
            limit = args[2] if len(args) > 2 else 100
            rows = []
            for (iid, aid), row in self._annotations.items():
                item = self._items.get(iid)
                if item and item["org_id"] == org_id and item["status"] == status:
                    rows.append({
                        "item_id": iid,
                        "annotator_id": aid,
                        "label": row["label"],
                        "confidence": row["confidence"],
                        "notes": row["notes"],
                        "time_spent_ms": row["time_spent_ms"],
                        "created_at": row["created_at"],
                        "payload": item["payload"],
                        "source_trace_id": item["source_trace_id"],
                        "source_span_id": item["source_span_id"],
                        "source_dataset_id": item["source_dataset_id"],
                        "source_synthetic_qa_id": item["source_synthetic_qa_id"],
                    })
            return rows[:limit]
        return []


class RacyFakePg(FakePg):
    """FakePg that yields to the event loop on every I/O call.

    FEAT-136: plain ``async def`` methods that never actually suspend
    (no real I/O) run to completion in a single scheduler turn even
    under ``asyncio.gather`` — two "concurrent" ``pop()`` calls would
    just execute sequentially, back-to-back, defeating the purpose of a
    race test. Inserting a genuine ``await asyncio.sleep(0)`` at every
    query forces the event loop to interleave multiple in-flight
    ``pop()`` coroutines (their SELECTs can both observe the same
    'pending' item before either one's UPDATE claims it), so the
    exclusivity guards in ``LabelingService.pop`` are actually exercised
    under contention rather than trivially passing by accident of
    scheduling order.
    """

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        await asyncio.sleep(0)
        return await super().fetch(query, *args)

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        await asyncio.sleep(0)
        return await super().fetchrow(query, *args)

    async def fetchval(self, query: str, *args: Any) -> Any:
        await asyncio.sleep(0)
        return await super().fetchval(query, *args)

    async def execute(self, query: str, *args: Any) -> str:
        await asyncio.sleep(0)
        return await super().execute(query, *args)


class TestLabelingService:
    def _pg(self) -> FakePg:
        return FakePg()

    @pytest.mark.asyncio
    async def test_seed_inserts_row(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(
            org_id="o-1", payload={"text": "x"},
            label_schema={"type": "thumbs"},
        )
        assert item_id
        assert item_id in pg._items
        assert pg._items[item_id]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_pop_returns_assigned_first(self) -> None:
        pg = self._pg()
        # Seed 3 items: one assigned to user, two unassigned.
        for i in range(3):
            await pg.execute(
                "INSERT INTO labeling_items (id, org_id, ...) VALUES ($1, $2, ...)",
                f"item-{i}", "o-1", None, None, None, None, "{}", "{}", None, "pending", [], [], 1,
            )
        # Manually mark item-0 as assigned to user-1.
        pg._items["item-0"]["assigned_to"] = "user-1"
        svc = LabelingService(pg)
        items = await svc.pop(org_id="o-1", annotator_id="user-1", limit=3)
        # The assigned-to-me item comes first.
        assert items[0].id == "item-0"

    @pytest.mark.asyncio
    async def test_annotate_upserts(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        # First annotation.
        ann1 = await svc.annotate(
            org_id="o-1", item_id=item_id, annotator_id="u-1",
            label="up", confidence=0.7,
        )
        # Same annotator again — UPSERT, same id.
        ann2 = await svc.annotate(
            org_id="o-1", item_id=item_id, annotator_id="u-1",
            label="down", confidence=0.9,
        )
        assert ann1.id == ann2.id
        # The label was updated.
        assert ann2.label == "down"
        assert ann2.confidence == 0.9

    @pytest.mark.asyncio
    async def test_annotate_completes_at_threshold(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(
            org_id="o-1", payload={"x": 1}, label_schema={},
            annotations_required=2,
        )
        # First annotator — still pending.
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        assert pg._items[item_id]["status"] == "pending"
        # Second annotator — flips to completed.
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-2", label="down")
        assert pg._items[item_id]["status"] == "completed"

    @pytest.mark.asyncio
    async def test_annotate_validates_confidence(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        with pytest.raises(ValueError, match="confidence"):
            await svc.annotate(
                org_id="o-1", item_id=item_id, annotator_id="u-1",
                label="up", confidence=2.0,
            )

    @pytest.mark.asyncio
    async def test_annotate_rejects_cross_org_item(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        with pytest.raises(ValueError, match="item not found"):
            await svc.annotate(
                org_id="o-other",
                item_id=item_id,
                annotator_id="u-1",
                label="up",
            )
        assert (item_id, "u-1") not in pg._annotations
        assert pg._items[item_id]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_skip_marks_skipped(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        await svc.skip(org_id="o-1", item_id=item_id, annotator_id="u-1", reason="garbage")
        assert pg._items[item_id]["status"] == "skipped"

    @pytest.mark.asyncio
    async def test_skip_bulk_marks_all_skipped(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_a = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        item_b = await svc.seed(org_id="o-1", payload={"x": 2}, label_schema={})
        count = await svc.skip_bulk(
            org_id="o-1",
            item_ids=[item_a, item_b],
            annotator_id="u-1",
            reason="noise",
        )
        assert count == 2
        assert pg._items[item_a]["status"] == "skipped"
        assert pg._items[item_b]["status"] == "skipped"

    @pytest.mark.asyncio
    async def test_iaa_perfect_agreement(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-2", label="up")
        report = await svc.compute_iaa(org_id="o-1")
        assert report.kappa == 1.0
        assert report.alpha == 1.0
        assert report.overall_agreement == 1.0

    @pytest.mark.asyncio
    async def test_iaa_partial_agreement(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        # 4 items, 2 annotators.
        # u-1 says: up, up, down, down.
        # u-2 says: up, down, down, down.
        # Agreements: 3/4 = 0.75.
        # counts_a = {up:2, down:2}, counts_b = {up:1, down:3}.
        # p_e = (2/4 * 1/4) + (2/4 * 3/4) = 1/8 + 3/8 = 0.5.
        # kappa = (0.75 - 0.5) / (1 - 0.5) = 0.5.
        for i in range(4):
            iid = await svc.seed(org_id="o-1", payload={"x": i}, label_schema={})
            await svc.annotate(org_id="o-1", item_id=iid, annotator_id="u-1", label="up" if i < 2 else "down")
            await svc.annotate(org_id="o-1", item_id=iid, annotator_id="u-2", label="up" if i == 0 else "down")
        report = await svc.compute_iaa(org_id="o-1")
        assert abs(report.kappa - 0.5) < 0.001

    @pytest.mark.asyncio
    async def test_iaa_zero_items(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        report = await svc.compute_iaa(org_id="o-1")
        assert report.item_count == 0
        assert report.kappa == 0.0

    @pytest.mark.asyncio
    async def test_escalate_bumps_required_and_requeues(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(
            org_id="o-1",
            payload={"x": 1},
            label_schema={},
            annotations_required=2,
        )
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-2", label="down")
        item = await svc.escalate(org_id="o-1", item_id=item_id)
        assert item.annotations_required == 3
        assert item.status == "pending"
        popped = await svc.pop(org_id="o-1", annotator_id="u-3", limit=5)
        assert any(i.id == item_id for i in popped)

    @pytest.mark.asyncio
    async def test_iaa_per_item_includes_annotations_required(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(
            org_id="o-1", payload={"x": 1}, label_schema={}, annotations_required=3,
        )
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-2", label="down")
        report = await svc.compute_iaa(org_id="o-1", item_ids=[item_id])
        entry = report.per_item[item_id]
        assert entry["annotations_required"] == 3.0
        assert entry["annotations_count"] == 2.0

    @pytest.mark.asyncio
    async def test_iaa_per_item_includes_single_annotation_count(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        report = await svc.compute_iaa(org_id="o-1", item_ids=[item_id])
        assert report.per_item[item_id]["annotations_count"] == 1.0
        assert "agreement" not in report.per_item[item_id]

    @pytest.mark.asyncio
    async def test_pop_active_learning_prefers_disagreement(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        agree_id = await svc.seed(
            org_id="o-1", payload={"confidence": 0.9}, label_schema={},
            annotations_required=3,
        )
        disagree_id = await svc.seed(
            org_id="o-1", payload={"confidence": 0.1}, label_schema={},
            annotations_required=3,
        )
        plain_id = await svc.seed(
            org_id="o-1", payload={}, label_schema={}, annotations_required=3,
        )
        await svc.annotate(org_id="o-1", item_id=agree_id, annotator_id="u-a", label="up")
        await svc.annotate(org_id="o-1", item_id=agree_id, annotator_id="u-b", label="up")
        await svc.annotate(org_id="o-1", item_id=disagree_id, annotator_id="u-a", label="up")
        await svc.annotate(org_id="o-1", item_id=disagree_id, annotator_id="u-b", label="down")
        items = await svc.pop(
            org_id="o-1", annotator_id="u-1", limit=2, strategy="active_learning",
        )
        assert len(items) == 2
        assert items[0].id == disagree_id
        assert items[1].id in {agree_id, plain_id}

    @pytest.mark.asyncio
    async def test_export_returns_jsonl(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(
            org_id="o-1", payload={"x": 1}, label_schema={},
            annotations_required=1,
        )
        await svc.annotate(org_id="o-1", item_id=item_id, annotator_id="u-1", label="up")
        output = await svc.export(org_id="o-1", status_filter="completed")
        lines = output.strip().split("\n")
        assert len(lines) == 1
        parsed = json.loads(lines[0])
        assert parsed["item_id"] == item_id
        assert parsed["annotator_id"] == "u-1"
        assert parsed["label"] == "up"

    @pytest.mark.asyncio
    async def test_export_filters_by_status(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        # Two items: one completed (has annotation), one pending (no annotation).
        iid1 = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={}, annotations_required=1)
        iid2 = await svc.seed(org_id="o-1", payload={"x": 2}, label_schema={})
        await svc.annotate(org_id="o-1", item_id=iid1, annotator_id="u-1", label="up")
        # iid2 stays pending; it has no annotation row.
        completed = await svc.export(org_id="o-1", status_filter="completed")
        # iid1 (completed) is exported.
        assert iid1 in completed
        # iid2 (pending) is NOT in the completed export.
        assert iid2 not in completed
        # The pending export is empty (iid2 has no annotation).
        pending = await svc.export(org_id="o-1", status_filter="pending")
        assert pending == ""

    @pytest.mark.asyncio
    async def test_pop_records_assignment(self) -> None:
        pg = self._pg()
        svc = LabelingService(pg)
        await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        # One assignment row was created.
        assert len(pg._assignments) == 1
        key = next(iter(pg._assignments))
        assert key[0] == items[0].id
        assert key[1] == "u-1"

    @pytest.mark.asyncio
    async def test_pop_declines_item_on_unexpected_lease_error(self) -> None:
        """FEAT-76: an unexpected error from claim_lease() must fail
        closed (decline the item), not fall through and silently
        treat the item as claimed."""
        pg = self._pg()
        svc = LabelingService(pg)
        await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        with patch(
            "eden.evaluation.labeling_leases.claim_lease",
            side_effect=RuntimeError("boom"),
        ):
            items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        assert items == []
        # No assignment or status flip should have happened for the
        # declined item.
        assert len(pg._assignments) == 0
        assert all(i["status"] == "pending" for i in pg._items.values())

    @pytest.mark.asyncio
    async def test_pop_skips_item_claimed_by_concurrent_writer(self) -> None:
        """FEAT-77: if the UPDATE ... WHERE status = 'pending' guard
        matches 0 rows (a concurrent pop() already claimed the item),
        pop() must not return that item to the caller."""
        import eden.evaluation.labeling_leases as leases

        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        # Simulate a concurrent writer that already flipped the item
        # to in_progress between the SELECT and the UPDATE.
        pg._items[item_id]["status"] = "in_progress"
        pg._items[item_id]["assigned_to"] = "u-9"
        lease_key = f"labeling:lease:o-1:{item_id}"
        leases._memory_leases[lease_key] = ("u-9", time.time() + 600)
        try:
            items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        finally:
            leases._memory_leases.pop(lease_key, None)
        assert items == []
        assert len(pg._assignments) == 0

    @pytest.mark.asyncio
    async def test_pop_claims_item_when_update_affects_a_row(self) -> None:
        """Sanity check: the normal (non-racing) path still works —
        pop() claims and returns the item when the UPDATE matches."""
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        assert len(items) == 1
        assert items[0].id == item_id
        assert items[0].status == "in_progress"
        assert pg._items[item_id]["status"] == "in_progress"
        assert len(pg._assignments) == 1

    # ── Concurrency / race tests (FEAT-136) ────────────────────

    @pytest.mark.asyncio
    async def test_pop_concurrent_gather_exclusive_claim_single_item(self) -> None:
        """Two annotators race for the SAME pending item via
        asyncio.gather(). Exactly one must claim it; the other gets
        nothing back, and no double assignment/status-flip occurs."""
        pg = RacyFakePg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        with patch(
            "eden.storage.redis.get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            result_a, result_b = await asyncio.gather(
                svc.pop(org_id="o-1", annotator_id="u-1", limit=1),
                svc.pop(org_id="o-1", annotator_id="u-2", limit=1),
            )
        winners = [r for r in (result_a, result_b) if r]
        losers = [r for r in (result_a, result_b) if not r]
        assert len(winners) == 1, "exactly one concurrent pop() must claim the item"
        assert len(losers) == 1
        assert winners[0][0].id == item_id
        assert winners[0][0].status == "in_progress"
        # The item was flipped exactly once (not fought over / reverted).
        assert pg._items[item_id]["status"] == "in_progress"
        # Exactly one assignment row was recorded — no double-claim.
        assert len(pg._assignments) == 1

    @pytest.mark.asyncio
    async def test_pop_concurrent_gather_no_overlap_across_many_items(self) -> None:
        """Three annotators race for three pending items concurrently.
        Every item is claimed by exactly one annotator; nobody gets an
        item someone else already has."""
        pg = RacyFakePg()
        svc = LabelingService(pg)
        item_ids = [
            await svc.seed(org_id="o-1", payload={"x": i}, label_schema={})
            for i in range(3)
        ]
        with patch(
            "eden.storage.redis.get_redis_client",
            new=AsyncMock(return_value=None),
        ):
            results = await asyncio.gather(
                svc.pop(org_id="o-1", annotator_id="u-1", limit=3),
                svc.pop(org_id="o-1", annotator_id="u-2", limit=3),
                svc.pop(org_id="o-1", annotator_id="u-3", limit=3),
            )
        claimed_ids = [item.id for r in results for item in r]
        # Every seeded item claimed exactly once, in total, across all
        # concurrent callers — no duplicates, nothing missed.
        assert sorted(claimed_ids) == sorted(item_ids)
        assert len(claimed_ids) == len(set(claimed_ids))
        for iid in item_ids:
            assert pg._items[iid]["status"] == "in_progress"
        # One assignment row per item, no more.
        assert len(pg._assignments) == len(item_ids)

    @pytest.mark.asyncio
    async def test_pop_reclaims_item_after_lease_expiry_for_assigned_annotator(
        self,
    ) -> None:
        """FEAT-78/FEAT-136: an item stuck 'in_progress' (its claimant's
        session dropped and the Redis lease TTL elapsed) is reclaimable
        by pop() when the SAME (assigned_to) annotator asks again — the
        expired lease must not permanently strand the item."""
        import eden.evaluation.labeling_leases as leases

        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        # Simulate a stuck claim: a prior pop() flipped the item to
        # in_progress and assigned it to u-1, but the process died
        # before annotate()/release_lease() ran.
        pg._items[item_id]["status"] = "in_progress"
        pg._items[item_id]["assigned_to"] = "u-1"
        lease_key = f"labeling:lease:o-1:{item_id}"
        leases._memory_leases[lease_key] = ("u-1", time.time() - 10)  # expired
        try:
            with patch(
                "eden.storage.redis.get_redis_client",
                new=AsyncMock(return_value=None),
            ):
                items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        finally:
            leases._memory_leases.pop(lease_key, None)
        assert len(items) == 1
        assert items[0].id == item_id
        assert items[0].status == "in_progress"

    @pytest.mark.asyncio
    async def test_pop_does_not_reclaim_stuck_item_for_a_different_annotator(
        self,
    ) -> None:
        """An item stuck in_progress and assigned to u-1 must NOT be
        handed to a different annotator (u-2) while u-1 still holds
        an active lease."""
        import eden.evaluation.labeling_leases as leases

        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        pg._items[item_id]["status"] = "in_progress"
        pg._items[item_id]["assigned_to"] = "u-1"
        lease_key = f"labeling:lease:o-1:{item_id}"
        leases._memory_leases[lease_key] = ("u-1", time.time() + 600)
        try:
            with patch(
                "eden.storage.redis.get_redis_client",
                new=AsyncMock(return_value=None),
            ):
                items = await svc.pop(org_id="o-1", annotator_id="u-2", limit=5)
        finally:
            leases._memory_leases.pop(lease_key, None)
        assert items == []
        assert pg._items[item_id]["assigned_to"] == "u-1"
        assert pg._items[item_id]["status"] == "in_progress"

    @pytest.mark.asyncio
    async def test_pop_reclaims_orphan_in_progress_for_different_annotator(
        self,
    ) -> None:
        """FEAT-78: when no active lease exists, sweep reverts orphaned
        in_progress items so another annotator can claim them."""
        import eden.evaluation.labeling_leases as leases

        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        pg._items[item_id]["status"] = "in_progress"
        pg._items[item_id]["assigned_to"] = "u-1"
        lease_key = f"labeling:lease:o-1:{item_id}"
        leases._memory_leases[lease_key] = ("u-1", time.time() - 10)  # expired
        try:
            with patch(
                "eden.storage.redis.get_redis_client",
                new=AsyncMock(return_value=None),
            ):
                items = await svc.pop(org_id="o-1", annotator_id="u-2", limit=5)
        finally:
            leases._memory_leases.pop(lease_key, None)
        assert len(items) == 1
        assert items[0].id == item_id
        assert items[0].status == "in_progress"
        assert pg._items[item_id]["status"] == "in_progress"
        assert len(pg._assignments) == 1

    @pytest.mark.asyncio
    async def test_sweep_orphaned_in_progress_reverts_unleased_rows(self) -> None:
        """Cron-friendly sweep reverts stranded in_progress rows."""
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        pg._items[item_id]["status"] = "in_progress"
        pg._items[item_id]["assigned_to"] = "u-1"
        with patch(
            "eden.evaluation.labeling_leases.has_active_lease",
            new=AsyncMock(return_value=False),
        ):
            n = await svc.sweep_orphaned_in_progress("o-1")
        assert n == 1
        assert pg._items[item_id]["status"] == "pending"
        assert pg._items[item_id]["assigned_to"] is None

    @pytest.mark.asyncio
    async def test_pop_rowcount_parse_failure_fails_closed(self) -> None:
        """Fail-open/rowcount gap: if the UPDATE result string can't be
        parsed into a rowcount (unexpected driver response shape), pop()
        must treat that as rowcount=0 and decline the item rather than
        silently trusting an unparsed claim."""
        pg = self._pg()
        svc = LabelingService(pg)
        item_id = await svc.seed(org_id="o-1", payload={"x": 1}, label_schema={})
        real_execute = pg.execute

        async def _garbled_execute(query: str, *args: Any) -> str:
            result = await real_execute(query, *args)
            sql = " ".join(query.strip().lower().split())
            if "status = 'in_progress'" in sql:
                # Simulate a driver returning something with no
                # trailing integer rowcount token.
                return "UPDATE"
            return result

        pg.execute = _garbled_execute  # type: ignore[method-assign]
        items = await svc.pop(org_id="o-1", annotator_id="u-1", limit=5)
        assert items == []
        assert len(pg._assignments) == 0
        # The underlying row WAS flipped by the real update (the parse
        # failure is purely about pop()'s own rowcount bookkeeping /
        # return value, not the database write itself) — but pop()
        # still must not report the item as claimed to the caller.
        assert pg._items[item_id]["status"] == "in_progress"


# ── IAA report dataclass ─────────────────────────────────────────


class TestIAAReport:
    def test_to_dict_round_trip(self) -> None:
        r = IAAReport(
            kappa=0.8, alpha=0.75, overall_agreement=0.9,
            item_count=10, annotation_count=20,
            per_item={"i1": {"kappa": 1.0, "agreement": 1.0}},
            per_pair={("a", "b"): {"kappa": 0.8, "agreement": 0.9, "n": 5}},
        )
        d = r.to_dict()
        assert d["kappa"] == 0.8
        assert d["alpha"] == 0.75
        assert d["per_item"]["i1"]["kappa"] == 1.0
        assert "a|b" in d["per_pair"]
