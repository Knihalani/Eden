"""Unit tests for active-learning ranking (FEAT-163)."""

from __future__ import annotations

from eden.evaluation.active_learning import (
    RankableLabelingItem,
    active_learning_score,
    agreement_from_iaa_per_item,
    extract_model_confidence,
    rank_for_active_learning,
    select_next_items,
)


def test_prefers_low_agreement_over_high() -> None:
    low = RankableLabelingItem(
        item_id="disagree", annotation_count=2, agreement=0.0,
    )
    high = RankableLabelingItem(
        item_id="agree", annotation_count=2, agreement=1.0,
    )
    ranked = rank_for_active_learning([high, low])
    assert ranked[0].item_id == "disagree"
    assert active_learning_score(low) > active_learning_score(high)


def test_prefers_one_annotation_over_zero_or_many() -> None:
    one = RankableLabelingItem(item_id="one", annotation_count=1)
    zero = RankableLabelingItem(item_id="zero", annotation_count=0)
    many = RankableLabelingItem(
        item_id="many", annotation_count=5, agreement=0.9,
    )
    ranked = rank_for_active_learning([many, zero, one])
    # Single-annotation beats zero and high-agreement many.
    assert ranked[0].item_id == "one"
    assert active_learning_score(one) > active_learning_score(zero)
    assert active_learning_score(one) > active_learning_score(many)


def test_prefers_model_uncertain_when_confidence_present() -> None:
    uncertain = RankableLabelingItem(
        item_id="unc", annotation_count=0, model_confidence=0.1,
    )
    certain = RankableLabelingItem(
        item_id="cert", annotation_count=0, model_confidence=0.95,
    )
    ranked = rank_for_active_learning([certain, uncertain])
    assert ranked[0].item_id == "unc"


def test_select_next_items_fifo_preserves_order() -> None:
    items = [
        RankableLabelingItem(item_id="a", annotation_count=0),
        RankableLabelingItem(item_id="b", annotation_count=1),
        RankableLabelingItem(item_id="c", annotation_count=2, agreement=0.0),
    ]
    out = select_next_items(items, limit=2, strategy="fifo")
    assert [x.item_id for x in out] == ["a", "b"]


def test_select_next_items_active_learning_reorders() -> None:
    items = [
        RankableLabelingItem(item_id="a", annotation_count=0),
        RankableLabelingItem(item_id="b", annotation_count=2, agreement=0.0),
        RankableLabelingItem(item_id="c", annotation_count=5, agreement=1.0),
    ]
    out = select_next_items(items, limit=2, strategy="active_learning")
    assert out[0].item_id == "b"
    assert len(out) == 2


def test_extract_model_confidence_keys() -> None:
    assert extract_model_confidence({"confidence": 0.42}) == 0.42
    assert extract_model_confidence({"model_confidence": "0.7"}) == 0.7
    assert extract_model_confidence({"other": 1}) is None
    assert extract_model_confidence(None) is None


def test_agreement_from_iaa_per_item() -> None:
    per = {"x": {"agreement": 0.25, "kappa": -0.5}}
    assert agreement_from_iaa_per_item(per, "x") == 0.25
    assert agreement_from_iaa_per_item({"y": {"kappa": 1.0}}, "y") == 1.0
    assert agreement_from_iaa_per_item(per, "missing") is None
