"""Tests for shared InjectBudget."""

from eden.llmops.inject_budget import InjectBudget, InjectItem, estimate_tokens


def test_estimate_tokens():
    assert estimate_tokens("abcd") >= 1


def test_hard_cap_truncates():
    budget = InjectBudget(soft_cap=10, hard_cap=20)
    items = [
        InjectItem(source="ledger", ref_id="1", text="x" * 400, priority=1.0),
        InjectItem(source="artifact", ref_id="2", text="y" * 400, priority=2.0),
    ]
    packed = budget.pack(items)
    assert packed.tokens <= 20
    assert packed.truncated is True


def test_do_not_repeat_packed_first():
    budget = InjectBudget(soft_cap=800, hard_cap=1200)
    items = [
        InjectItem(
            source="ledger",
            ref_id="dnr",
            text="NEVER repeat this",
            always_include=True,
        ),
        InjectItem(source="artifact", ref_id="a", text="low", priority=0.1),
    ]
    packed = budget.pack(items)
    assert "NEVER repeat" in packed.text
