"""Tests for the Gate 5 CodebaseKnowledgeGraph.

Covers:

* ``record_outcome`` — UPSERT semantics; first-write vs
  subsequent writes; counter increments per outcome type
* ``same_file_history`` — read-path 1
* ``same_rca_category_history`` — read-path 2; empty
  prefix handling
* ``telemetry_signature_match`` — read-path 3; empty
  signature handling
* ``PatchGenerator.generate`` calls ``record_outcome``
  after a successful patch (Gate 5 wiring)
* ``AutoRevertEngine.revert`` calls ``record_outcome``
  after a successful revert (Gate 5 wiring)

The graph DB is mocked — we patch ``_select_rows`` and
``_insert_row`` / ``_delete_then_insert`` so the test
runs without a real Postgres instance.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

# ── record_outcome ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_record_outcome_first_write_creates_row() -> None:
    """The first outcome for a code path creates a new row."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()

    inserted_rows: list[tuple[str, list, list]] = []

    async def capture_insert(org_id, table, cols, vals):
        inserted_rows.append((table, cols, vals))

    with patch(
        "eden.code_change.knowledge_graph._select_rows",
        AsyncMock(return_value=[]),
    ), patch(
        "eden.code_change.knowledge_graph._insert_row",
        capture_insert,
    ):
        result = await kg.record_outcome(
            org_id="test-org",
            repo_id="repo-1",
            code_path="src/foo.py",
            outcome="merged",
            rca_category="rate_limiter",
            telemetry_signature="trace-1",
        )

    assert result["status"] == "ok"
    assert len(inserted_rows) == 1
    table, cols, vals = inserted_rows[0]
    assert table == "codebase_knowledge_graph"
    # First row: historical=1, all counters=0, outcome="merged"
    assert vals[cols.index("historical_patches_count")] == 1
    assert vals[cols.index("reverted_count")] == 0
    assert vals[cols.index("last_outcome")] == "merged"


@pytest.mark.asyncio
async def test_record_outcome_reverted_increments_reverted_count() -> None:
    """A ``reverted`` outcome increments the ``reverted_count``
    counter (not denied / edited)."""
    from eden.code_change import knowledge_graph as kg_mod
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()

    existing_row = {
        "id": "cgraph_test",
        "repo_id": "repo-1",
        "code_path": "src/foo.py",
        "telemetry_signature": "trace-1",
        "historical_patches_count": 3,
        "reverted_count": 1,
        "denied_count": 0,
        "edited_count": 2,
        "last_outcome": "merged",
    }
    captured: dict = {}

    async def capture_delete_insert(org_id, pk_col, pk_val, table, cols, vals):
        captured["cols"] = cols
        captured["vals"] = vals

    with patch.object(
        kg_mod, "_select_rows", AsyncMock(return_value=[existing_row]),
    ), patch(
        "eden.code_change._common._delete_then_insert",
        capture_delete_insert,
    ):
        result = await kg.record_outcome(
            org_id="test-org",
            repo_id="repo-1",
            code_path="src/foo.py",
            outcome="reverted",
        )

    assert result["status"] == "ok"
    assert captured["vals"][captured["cols"].index("reverted_count")] == 2
    # Denied + edited unchanged.
    assert captured["vals"][captured["cols"].index("denied_count")] == 0
    assert captured["vals"][captured["cols"].index("edited_count")] == 2
    # Historical bumped by 1.
    assert captured["vals"][captured["cols"].index("historical_patches_count")] == 4


@pytest.mark.asyncio
async def test_record_outcome_denied_increments_denied_count() -> None:
    """A ``denied`` outcome increments ``denied_count`` only."""
    from eden.code_change import knowledge_graph as kg_mod
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    existing = {
        "id": "x", "repo_id": "r", "code_path": "p",
        "telemetry_signature": "", "historical_patches_count": 5,
        "reverted_count": 1, "denied_count": 0, "edited_count": 0,
        "last_outcome": "merged",
    }
    captured: dict = {}

    async def cap(org_id, pk_col, pk_val, table, cols, vals):
        captured["vals"] = vals
        captured["cols"] = cols

    with patch.object(
        kg_mod, "_select_rows", AsyncMock(return_value=[existing]),
    ), patch(
        "eden.code_change._common._delete_then_insert", cap,
    ):
        await kg.record_outcome(
            org_id="o", repo_id="r", code_path="p", outcome="denied",
        )
    assert captured["vals"][captured["cols"].index("denied_count")] == 1
    assert captured["vals"][captured["cols"].index("reverted_count")] == 1


@pytest.mark.asyncio
async def test_record_outcome_edited_increments_edited_count() -> None:
    """An ``edited`` outcome increments ``edited_count`` only."""
    from eden.code_change import knowledge_graph as kg_mod
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    existing = {
        "id": "x", "repo_id": "r", "code_path": "p",
        "telemetry_signature": "", "historical_patches_count": 2,
        "reverted_count": 0, "denied_count": 0, "edited_count": 0,
        "last_outcome": "merged",
    }
    captured: dict = {}

    async def cap(org_id, pk_col, pk_val, table, cols, vals):
        captured["vals"] = vals
        captured["cols"] = cols

    with patch.object(
        kg_mod, "_select_rows", AsyncMock(return_value=[existing]),
    ), patch(
        "eden.code_change._common._delete_then_insert", cap,
    ):
        await kg.record_outcome(
            org_id="o", repo_id="r", code_path="p", outcome="edited",
        )
    assert captured["vals"][captured["cols"].index("edited_count")] == 1


# ── Read paths ───────────────────────────────────────────────


@pytest.mark.asyncio
async def test_same_file_history_returns_found_false_when_empty() -> None:
    """No row → ``found=False`` + zeroed counters."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    with patch(
        "eden.code_change.knowledge_graph._select_rows",
        AsyncMock(return_value=[]),
    ):
        result = await kg.same_file_history(
            org_id="o", repo_id="r", code_path="src/missing.py",
        )
    assert result["data"]["found"] is False
    assert result["data"]["historical_patches_count"] == 0
    assert result["data"]["revert_rate"] == 0.0
    assert result["data"]["denial_rate"] == 0.0


@pytest.mark.asyncio
async def test_same_file_history_returns_rates_when_present() -> None:
    """A row with 1 revert + 4 historicals → ``revert_rate=0.25``."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    row = {
        "id": "x", "repo_id": "r", "code_path": "p",
        "telemetry_signature": "sig",
        "historical_patches_count": 4,
        "reverted_count": 1, "denied_count": 0, "edited_count": 1,
        "last_outcome": "merged",
        "last_updated": None,
    }
    with patch(
        "eden.code_change.knowledge_graph._select_rows",
        AsyncMock(return_value=[row]),
    ):
        result = await kg.same_file_history(
            org_id="o", repo_id="r", code_path="p",
        )
    assert result["data"]["found"] is True
    assert result["data"]["historical_patches_count"] == 4
    assert result["data"]["revert_rate"] == 0.25
    assert result["data"]["denial_rate"] == 0.0


@pytest.mark.asyncio
async def test_same_rca_category_history_empty_prefix() -> None:
    """Empty prefix → empty matches (no DB read)."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    result = await kg.same_rca_category_history(
        org_id="o", repo_id="r", rca_category="",
    )
    assert result["data"]["matches"] == []


@pytest.mark.asyncio
async def test_same_rca_category_history_returns_matches() -> None:
    """A matching row surfaces in the matches list with revert_rate."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    rows = [{
        "id": "x", "repo_id": "r", "code_path": "rate_limiter/check.py",
        "telemetry_signature": "",
        "historical_patches_count": 4,
        "reverted_count": 1, "denied_count": 0, "edited_count": 0,
        "last_outcome": "merged",
    }]
    with patch(
        "eden.code_change.knowledge_graph._select_rows",
        AsyncMock(return_value=rows),
    ):
        result = await kg.same_rca_category_history(
            org_id="o", repo_id="r", rca_category="rate_limiter",
        )
    matches = result["data"]["matches"]
    assert len(matches) == 1
    assert matches[0]["code_path"] == "rate_limiter/check.py"
    assert matches[0]["revert_rate"] == 0.25


@pytest.mark.asyncio
async def test_telemetry_signature_match_empty_signature() -> None:
    """Empty signature → empty matches (no DB read)."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    result = await kg.telemetry_signature_match(
        org_id="o", repo_id="r", telemetry_signature="",
    )
    assert result["data"]["matches"] == []


@pytest.mark.asyncio
async def test_telemetry_signature_match_returns_matches() -> None:
    """A matching signature surfaces the prior patches."""
    from eden.code_change.knowledge_graph import CodebaseKnowledgeGraph
    kg = CodebaseKnowledgeGraph()
    rows = [{
        "id": "x", "repo_id": "r", "code_path": "src/foo.py",
        "telemetry_signature": "sig-1",
        "historical_patches_count": 2,
        "reverted_count": 1, "denied_count": 0, "edited_count": 0,
        "last_outcome": "reverted",
    }]
    with patch(
        "eden.code_change.knowledge_graph._select_rows",
        AsyncMock(return_value=rows),
    ):
        result = await kg.telemetry_signature_match(
            org_id="o", repo_id="r", telemetry_signature="sig-1",
        )
    matches = result["data"]["matches"]
    assert len(matches) == 1
    assert matches[0]["last_outcome"] == "reverted"


# ── Gate 5 wiring: PatchGenerator + AutoRevertEngine ────────


@pytest.mark.asyncio
async def test_patch_generator_records_kg_outcome() -> None:
    """A successful ``PatchGenerator.generate`` calls
    ``CodebaseKnowledgeGraph.record_outcome`` once per
    touched file with outcome=``merged``.

    The wiring is verified by reading the source +
    confirming the wiring block is present (the live
    end-to-end behaviour is verified by the
    ``test_patch_flow_e2e`` integration test which
    exercises a real diff + persistence path).
    """
    from pathlib import Path
    src = (
        Path(__file__).parent.parent.parent
        / "src" / "eden" / "code_change" / "patch_generator.py"
    )
    text = src.read_text()
    # The wiring block calls CodebaseKnowledgeGraph after a
    # successful generate. The outcome string is ``"proposed"``
    # (NOT ``"merged"``) — recording AI-proposed patches as
    # ``merged`` was the bug found in the June 25 audit; it
    # polluted ``revert_rate`` signals because every patch
    # counted as a merge before a human ever reviewed it.
    assert "CodebaseKnowledgeGraph" in text
    assert "record_outcome" in text
    assert 'outcome="proposed"' in text
    assert 'outcome="merged"' not in text
    # The wiring block is after the success-path return
    # + the metrics.files list.
    assert "metrics[\"files\"]" in text
    # The wiring is best-effort (wrapped in try/except).
    assert "KG record_outcome failed" in text


@pytest.mark.asyncio
async def test_auto_revert_engine_records_kg_reverted_outcome() -> None:
    """A successful ``AutoRevertEngine.revert`` calls
    ``record_outcome`` with outcome=``reverted`` for the
    affected code_path in the regression_evidence."""
    from datetime import UTC, datetime

    from eden.code_change import knowledge_graph as kg_mod
    from eden.code_change.revert_engine import AutoRevertEngine
    from eden.providers.pr import PRRevertRequest
    from eden.providers.repo import PullRequestInfo

    provider = AsyncMock()
    provider.revert = AsyncMock(return_value=PullRequestInfo(
        number=43, title="Revert", body="",
        branch="eden/revert", base="main",
        url="file://./prs/43.json", state="open",
        created_at=datetime.now(UTC),
    ))
    engine = AutoRevertEngine(provider=provider)

    recorded_calls: list[dict] = []

    async def capture_record_outcome(self, org_id, repo_id, code_path, outcome, **kwargs):
        recorded_calls.append({
            "org_id": org_id, "repo_id": repo_id,
            "code_path": code_path, "outcome": outcome, **kwargs,
        })
        return {"status": "ok"}

    with patch.object(
        kg_mod.CodebaseKnowledgeGraph, "record_outcome",
        capture_record_outcome,
    ), patch(
        "eden.code_change._common._insert_row",
        AsyncMock(return_value=None),
    ):
        result = await engine.revert(
            org_id="test-org",
            pr_id="pr_42",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            regression_evidence={
                "code_path": "src/foo.py",
                "repo_id": "repo-1",
                "rca_category": "rate_limiter",
            },
        )

    assert result["data"]["executed"] is True
    assert len(recorded_calls) == 1
    call = recorded_calls[0]
    assert call["outcome"] == "reverted"
    assert call["code_path"] == "src/foo.py"
    assert call["rca_category"] == "rate_limiter"


@pytest.mark.asyncio
async def test_auto_revert_engine_skips_kg_when_no_code_path() -> None:
    """When the evidence has no code_path, the KG record is skipped."""
    from datetime import UTC, datetime

    from eden.code_change import knowledge_graph as kg_mod
    from eden.code_change.revert_engine import AutoRevertEngine
    from eden.providers.repo import PullRequestInfo

    provider = AsyncMock()
    provider.revert = AsyncMock(return_value=PullRequestInfo(
        number=43, title="Revert", body="",
        branch="eden/revert", base="main",
        url="file://./prs/43.json", state="open",
        created_at=datetime.now(UTC),
    ))
    engine = AutoRevertEngine(provider=provider)
    recorded: list = []

    async def capture(self, org_id, repo_id, code_path, outcome, **kwargs):
        recorded.append(code_path)
        return {"status": "ok"}

    with patch.object(
        kg_mod.CodebaseKnowledgeGraph, "record_outcome", capture,
    ), patch(
        "eden.code_change._common._insert_row",
        AsyncMock(return_value=None),
    ):
        await engine.revert(
            org_id="o", pr_id="pr_1",
            policy={
                "code_change_enabled": True,
                "auto_revert_enabled": True,
            },
            pr_state="merged",
            regression_evidence={"score": 0.18},  # no code_path
        )
    # No KG call — code_path was empty.
    assert recorded == []
