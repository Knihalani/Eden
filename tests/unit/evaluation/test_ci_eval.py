"""F56 CI-eval: score table, history shaping, commit-status fail-open."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from eden.evaluation.ci_eval_commit_status import build_check_payload, post_commit_status
from eden.evaluation.ci_eval_history import CIEvalHistoryStore
from eden.evaluation.ci_webhook import build_score_table, render_summary_md

# ── score table ──────────────────────────────────────────────────────

def test_score_table_no_baseline_is_new() -> None:
    rows = build_score_table(
        {"passed": 3, "failed": 1, "skipped": 0, "errors": 0, "total": 4}, None
    )
    assert {r["metric"] for r in rows} == {
        "pass_rate",
        "fail_rate",
        "skip_rate",
        "error_rate",
    }
    for r in rows:
        assert set(r.keys()) == {"metric", "baseline", "current", "delta", "verdict"}
        assert r["baseline"] is None
        assert r["delta"] is None
        assert r["verdict"] == "new"


def test_score_table_regression_direction() -> None:
    # pass_rate fell 1.0 -> 0.8, fail_rate rose 0.0 -> 0.2 => both regressions.
    rows = build_score_table(
        {"passed": 8, "failed": 2, "skipped": 0, "errors": 0, "total": 10},
        {"passed": 10, "failed": 0, "skipped": 0, "errors": 0, "total": 10},
    )
    by = {r["metric"]: r for r in rows}
    assert by["pass_rate"]["verdict"] == "regression"
    assert by["fail_rate"]["verdict"] == "regression"
    assert by["pass_rate"]["delta"] == pytest.approx(-0.2)


def test_score_table_improvement_direction() -> None:
    rows = build_score_table(
        {"passed": 10, "failed": 0, "skipped": 0, "errors": 0, "total": 10},
        {"passed": 8, "failed": 2, "skipped": 0, "errors": 0, "total": 10},
    )
    by = {r["metric"]: r for r in rows}
    assert by["pass_rate"]["verdict"] == "improvement"
    assert by["fail_rate"]["verdict"] == "improvement"


def test_score_table_includes_per_case_f51_rows() -> None:
    rows = build_score_table(
        {"passed": 1, "failed": 0, "skipped": 0, "errors": 0, "total": 1},
        {"passed": 1, "failed": 0, "skipped": 0, "errors": 0, "total": 1},
        f51_grades=[
            {
                "case_id": "c1",
                "fingerprint": "fp-c1",
                "current_score": 0.9,
                "reason": "ok",
            },
            {
                "case_id": "c2",
                "fingerprint": None,
                "current_score": 0.4,
                "reason": "ok",
            },
        ],
        baseline_f51_grades=[
            {"case_id": "c1", "current_score": 0.8},
            {"case_id": "c2", "current_score": 0.5},
        ],
    )
    metrics = {r["metric"] for r in rows}
    assert "pass_rate" in metrics
    assert "case:fp-c1" in metrics
    assert "case:c2" in metrics
    by = {r["metric"]: r for r in rows}
    assert by["case:fp-c1"]["verdict"] == "improvement"
    assert by["case:fp-c1"]["delta"] == pytest.approx(0.1)
    assert by["case:c2"]["verdict"] == "regression"
    assert by["case:c2"]["delta"] == pytest.approx(-0.1)


def test_score_table_per_case_no_baseline_is_new() -> None:
    rows = build_score_table(
        {"passed": 1, "failed": 0, "skipped": 0, "errors": 0, "total": 1},
        None,
        f51_grades=[{"case_id": "c9", "current_score": 1.0, "reason": "ok"}],
    )
    case_rows = [r for r in rows if r["metric"].startswith("case:")]
    assert len(case_rows) == 1
    assert case_rows[0]["verdict"] == "new"
    assert case_rows[0]["baseline"] is None


def test_score_table_per_case_unscored_is_skipped() -> None:
    rows = build_score_table(
        {"passed": 0, "failed": 0, "skipped": 1, "errors": 0, "total": 1},
        None,
        f51_grades=[{"case_id": "c0", "current_score": None, "reason": "no_scorers"}],
    )
    case_rows = [r for r in rows if r["metric"].startswith("case:")]
    assert case_rows[0]["verdict"] == "skipped"
    assert case_rows[0]["current"] is None


def test_render_summary_md_has_table_and_verdict() -> None:
    data = {
        "summary": {
            "passed": 8,
            "failed": 2,
            "skipped": 0,
            "errors": 0,
            "total": 10,
            "ok": False,
        },
        "score_table": build_score_table(
            {"passed": 8, "failed": 2, "skipped": 0, "errors": 0, "total": 10}, None
        ),
    }
    md = render_summary_md(data)
    assert "Regression gate: **block**" in md
    assert "| metric | baseline | current | delta | verdict |" in md
    assert "pass_rate" in md


def test_render_summary_md_includes_scorer_gate() -> None:
    data = {
        "summary": {"passed": 1, "failed": 0, "skipped": 0, "errors": 0, "total": 1, "ok": True},
        "score_table": build_score_table(
            {"passed": 1, "failed": 0, "skipped": 0, "errors": 0, "total": 1}, None
        ),
        "scorer_gate": {
            "ran": True,
            "ok": False,
            "mean_score": 0.8,
            "baseline_mean_score": 1.0,
            "passed": 0,
            "failed": 1,
            "errors": 0,
        },
    }
    md = render_summary_md(data)
    assert "Scorer gate: **block**" in md


# ── history shaping ──────────────────────────────────────────────────

def test_shape_row_computes_counts_and_ok() -> None:
    row = {
        "id": "abc",
        "org_id": "org-1",
        "agent_id": None,
        "change_id": "pr-9",
        "passed": 4,
        "failed": 0,
        "status": "completed",
        "created_at": datetime(2026, 8, 4, tzinfo=UTC),
        "metadata": {
            "skipped": 1,
            "errors": 0,
            "ref": "refs/heads/main",
            "commit_sha": "deadbeef",
            "pr_number": 9,
        },
    }
    shaped = CIEvalHistoryStore._shape_row(row, detail=False)
    assert shaped["counts"] == {
        "passed": 4,
        "failed": 0,
        "skipped": 1,
        "errors": 0,
        "total": 5,
    }
    assert shaped["ok"] is True  # skips allowed by default policy
    assert shaped["ref"] == "refs/heads/main"
    assert shaped["commit_sha"] == "deadbeef"
    assert shaped["created_at"] == "2026-08-04T00:00:00+00:00"


def test_shape_row_errors_fail_closed() -> None:
    row = {
        "id": "x",
        "org_id": "o",
        "passed": 1,
        "failed": 0,
        "status": "completed",
        "created_at": "2026-08-04T00:00:00+00:00",
        "metadata": {"skipped": 0, "errors": 1},
    }
    shaped = CIEvalHistoryStore._shape_row(row, detail=False)
    assert shaped["ok"] is False


@pytest.mark.asyncio
async def test_history_memory_only_is_empty() -> None:
    store = CIEvalHistoryStore(memory_only=True)
    page = await store.list_runs("org-1")
    assert page == {"runs": [], "limit": 20, "offset": 0, "total": 0}
    assert await store.get_run("org-1", "missing") is None


# ── commit-status fail-open ──────────────────────────────────────────

def test_build_check_payload_conclusion() -> None:
    ok = build_check_payload(head_sha="a" * 40, ok=True, summary_md="x")
    bad = build_check_payload(head_sha="b" * 40, ok=False, summary_md="x")
    assert ok["conclusion"] == "success"
    assert bad["conclusion"] == "failure"
    assert ok["name"] == "Eden eval"


@pytest.mark.asyncio
async def test_commit_status_missing_repo_no_call() -> None:
    res = await post_commit_status(
        "org-1", repo_full_name=None, commit_sha=None, ok=True, summary_md="x"
    )
    assert res == {"posted": False, "reason": "missing_repo_or_sha"}


@pytest.mark.asyncio
async def test_commit_status_invalid_repo() -> None:
    res = await post_commit_status(
        "org-1", repo_full_name="noslash", commit_sha="abc", ok=True, summary_md="x"
    )
    assert res == {"posted": False, "reason": "invalid_repo"}
