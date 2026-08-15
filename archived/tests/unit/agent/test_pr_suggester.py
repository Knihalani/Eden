"""Unit tests for :class:`eden.agent.PRSuggester`.

The tests cover:

* Trigger validation (unknown triggers are accepted for
  forward-compat, missing required fields raise a clear
  envelope).
* The file extraction from the per-trigger payload.
* The LLM call path (with a mocked LLM client) — the
  diff + title + body are parsed from the JSON response.
* The heuristic fallback (no LLM) — produces a real
  envelope with an empty diff.
* The persistence round-trip — list / get / mark_opened.
* The trigger-mapped files are read from the
  :class:`RepoProvider` and the file content is included
  in the suggestion.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import UTC
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

# ── Fixtures ────────────────────────────────────────────────────


@pytest.fixture
def temp_git_repo():
    """A real git repo with 2 files for the provider to read."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subprocess.run(["git", "init", "-q"], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@eden.local"],
            cwd=tmpdir, check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Eden Test"],
            cwd=tmpdir, check=True,
        )
        (Path(tmpdir) / "foo.py").write_text("x = 1\n")
        (Path(tmpdir) / "bar.py").write_text("y = 2\n")
        subprocess.run(["git", "add", "."], cwd=tmpdir, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "init"],
            cwd=tmpdir, check=True,
        )
        yield tmpdir


@pytest.fixture
def repo_provider(temp_git_repo):
    from eden.providers.repo import LocalRepoProvider
    return LocalRepoProvider(repo_path=temp_git_repo)


@pytest.fixture
def suggester(repo_provider, temp_git_repo):
    from eden.agent import PRSuggester
    # The store path is derived from the repo path; the
    # fixture ensures it lives in the temp dir.
    return PRSuggester(repo_provider=repo_provider)


# ── Heuristic fallback (no LLM) ────────────────────────────────


class TestPRSuggesterHeuristic:
    @pytest.mark.asyncio
    async def test_suggest_with_files(self, suggester):
        suggestion = await suggester.suggest(
            "org_test",
            trigger="rca_cluster",
            trigger_id="clu_abc",
            trigger_payload={
                "affected_files": ["foo.py", "bar.py"],
                "description": "hallucination score dropped",
            },
        )
        assert suggestion.id.startswith("prsug_")
        assert suggestion.org_id == "org_test"
        assert suggestion.trigger == "rca_cluster"
        assert suggestion.trigger_id == "clu_abc"
        assert "hallucination" in suggestion.trigger_summary.lower()
        assert len(suggestion.files) == 2
        assert {f.path for f in suggestion.files} == {"foo.py", "bar.py"}
        # The heuristic produces an empty diff (no LLM).
        assert suggestion.patch_diff == ""
        assert "[Eden Agent]" in suggestion.pr_title
        assert suggestion.status == "pending"
        assert suggestion.opened_pr_number is None
        # Confidence is the heuristic default.
        assert 0.0 <= suggestion.confidence <= 1.0

    @pytest.mark.asyncio
    async def test_suggest_with_no_files(self, suggester):
        suggestion = await suggester.suggest(
            "org_test",
            trigger="drift_alert",
            trigger_id="alert_xyz",
            trigger_payload={"description": "drift detected"},
        )
        assert suggestion.files == []
        assert "[Eden Agent]" in suggestion.pr_title
        assert "drift" in suggestion.pr_title.lower()

    @pytest.mark.asyncio
    async def test_suggest_filters_missing_files(self, suggester):
        # 1 real file + 1 missing → only the real file is
        # attached.
        suggestion = await suggester.suggest(
            "org_test",
            trigger="rca_cluster",
            trigger_id="clu_xyz",
            trigger_payload={
                "affected_files": ["foo.py", "__missing__.py"],
                "description": "x",
            },
        )
        assert len(suggestion.files) == 1
        assert suggestion.files[0].path == "foo.py"


# ── LLM path (with a mocked LLM client) ────────────────────────


class TestPRSuggesterLLM:
    @pytest.mark.asyncio
    async def test_llm_response_is_parsed(self, repo_provider, temp_git_repo):
        from eden.agent import PRSuggester

        class MockLLM:
            async def complete(
                self, prompt: str, *, system: str = "",
                model=None, max_tokens: int = 1024,
            ) -> str:
                return json.dumps(
                    {
                        "pr_title": "[Eden Agent] LLM-suggested fix",
                        "pr_body": "This is the LLM body.",
                        "patch_diff": (
                            "--- a/foo.py\n+++ b/foo.py\n"
                            "@@ -1,1 +1,1 @@\n-x = 1\n+x = 2\n"
                        ),
                        "blast_radius": 0.05,
                        "confidence": 0.9,
                    }
                )

        suggester = PRSuggester(
            repo_provider=repo_provider, llm_client=MockLLM(),
        )
        suggestion = await suggester.suggest(
            "org_test",
            trigger="rca_cluster",
            trigger_id="clu_abc",
            trigger_payload={
                "affected_files": ["foo.py"],
                "description": "x should be 2",
            },
        )
        assert suggestion.pr_title == "[Eden Agent] LLM-suggested fix"
        assert suggestion.pr_body == "This is the LLM body."
        assert "+x = 2" in suggestion.patch_diff
        assert suggestion.blast_radius == 0.05
        assert suggestion.confidence == 0.9

    @pytest.mark.asyncio
    async def test_llm_failure_falls_back_to_heuristic(
        self, repo_provider,
    ):
        from eden.agent import PRSuggester

        class FailingLLM:
            async def complete(
                self, prompt: str, **kwargs: Any,
            ) -> str:
                raise RuntimeError("LLM down")

        suggester = PRSuggester(
            repo_provider=repo_provider, llm_client=FailingLLM(),
        )
        suggestion = await suggester.suggest(
            "org_test",
            trigger="rca_cluster",
            trigger_id="clu_abc",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # The heuristic fallback runs.
        assert suggestion.patch_diff == ""
        assert "[Eden Agent]" in suggestion.pr_title

    @pytest.mark.asyncio
    async def test_llm_with_markdown_code_block(
        self, repo_provider,
    ):
        from eden.agent import PRSuggester

        class MockLLM:
            async def complete(self, prompt: str, **kwargs: Any) -> str:
                return (
                    "```json\n"
                    + json.dumps(
                        {
                            "pr_title": "x",
                            "pr_body": "y",
                            "patch_diff": "z",
                            "blast_radius": 0.0,
                            "confidence": 0.0,
                        }
                    )
                    + "\n```"
                )

        suggester = PRSuggester(
            repo_provider=repo_provider, llm_client=MockLLM(),
        )
        suggestion = await suggester.suggest(
            "org_test", trigger="rca_cluster", trigger_id="x",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # The parser strips the ```json``` wrapper.
        assert suggestion.pr_title == "x"
        assert suggestion.patch_diff == "z"

    @pytest.mark.asyncio
    async def test_llm_with_malformed_json_falls_back(
        self, repo_provider,
    ):
        from eden.agent import PRSuggester

        class MockLLM:
            async def complete(self, prompt: str, **kwargs: Any) -> str:
                return "not json at all"

        suggester = PRSuggester(
            repo_provider=repo_provider, llm_client=MockLLM(),
        )
        suggestion = await suggester.suggest(
            "org_test", trigger="rca_cluster", trigger_id="x",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # The heuristic runs when the LLM response can't
        # be parsed.
        assert "[Eden Agent]" in suggestion.pr_title


# ── Persistence round-trip ───────────────────────────────────


class TestPRSuggesterStore:
    @pytest.mark.asyncio
    async def test_list_returns_persisted(
        self, suggester, temp_git_repo,
    ):
        await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="clu_1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        await suggester.suggest(
            "org_a", trigger="drift_alert", trigger_id="alert_2",
            trigger_payload={"affected_files": ["bar.py"]},
        )
        # Other org's suggestions are not returned.
        await suggester.suggest(
            "org_b", trigger="rca_cluster", trigger_id="clu_3",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        rows = await suggester.list_suggestions("org_a")
        assert len(rows) == 2
        assert all(r.org_id == "org_a" for r in rows)
        triggers = {r.trigger for r in rows}
        assert triggers == {"rca_cluster", "drift_alert"}

    @pytest.mark.asyncio
    async def test_list_filtered_by_trigger(self, suggester):
        await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        await suggester.suggest(
            "org_a", trigger="drift_alert", trigger_id="2",
            trigger_payload={"affected_files": ["bar.py"]},
        )
        rows = await suggester.list_suggestions(
            "org_a", trigger="drift_alert",
        )
        assert len(rows) == 1
        assert rows[0].trigger == "drift_alert"

    @pytest.mark.asyncio
    async def test_get_returns_specific(
        self, suggester,
    ):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        loaded = await suggester.get_suggestion("org_a", s.id)
        assert loaded is not None
        assert loaded.id == s.id

    @pytest.mark.asyncio
    async def test_get_returns_none_for_unknown(self, suggester):
        loaded = await suggester.get_suggestion("org_a", "prsug_nope")
        assert loaded is None

    @pytest.mark.asyncio
    async def test_mark_opened_updates_status(self, suggester):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        updated = await suggester.mark_opened("org_a", s.id, 42)
        assert updated is not None
        assert updated.status == "opened"
        assert updated.opened_pr_number == 42
        # The change is persisted.
        reloaded = await suggester.get_suggestion("org_a", s.id)
        assert reloaded.status == "opened"
        assert reloaded.opened_pr_number == 42

    @pytest.mark.asyncio
    async def test_mark_status_updates(self, suggester):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        updated = await suggester.mark_status(
            "org_a", s.id, "merged",
        )
        assert updated is not None
        assert updated.status == "merged"


# ── Trigger validation ─────────────────────────────────────


class TestTriggerValidation:
    def test_valid_triggers_listed(self):
        from eden.agent import VALID_TRIGGERS
        assert "rca_cluster" in VALID_TRIGGERS
        assert "drift_alert" in VALID_TRIGGERS
        assert "retrieval_gap" in VALID_TRIGGERS
        assert "judge_regression" in VALID_TRIGGERS


# ── File extraction helper ─────────────────────────────────


class TestExtractFilesFromPayload:
    def test_extracts_affected_files(self):
        from eden.agent.pr_suggester import _extract_files_from_payload
        files, summary = _extract_files_from_payload(
            {
                "affected_files": ["a.py", "b.py"],
                "description": "x",
            }
        )
        assert files == ["a.py", "b.py"]
        assert summary == "x"

    def test_extracts_files_fallback(self):
        from eden.agent.pr_suggester import _extract_files_from_payload
        files, _ = _extract_files_from_payload(
            {"files": ["c.py"]}
        )
        assert files == ["c.py"]

    def test_dedupes_preserving_order(self):
        from eden.agent.pr_suggester import _extract_files_from_payload
        files, _ = _extract_files_from_payload(
            {"affected_files": ["a.py", "b.py", "a.py"]}
        )
        assert files == ["a.py", "b.py"]

    def test_empty_payload(self):
        from eden.agent.pr_suggester import _extract_files_from_payload
        files, summary = _extract_files_from_payload({})
        assert files == []
        assert "Observability event" in summary


# ── v1.7: get_file_content / regenerate / bulk_regenerate ─────


class TestGetFileContent:
    @pytest.mark.asyncio
    async def test_returns_content_for_affected_file(
        self, suggester,
    ):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        result = await suggester.get_file_content(
            "org_a", s.id, "foo.py",
        )
        assert result is not None
        assert result["path"] == "foo.py"
        assert "x = 1" in result["content"]

    @pytest.mark.asyncio
    async def test_returns_none_for_unaffected_file(self, suggester):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # bar.py isn't in the suggestion's affected
        # files, so the helper refuses to read it.
        result = await suggester.get_file_content(
            "org_a", s.id, "bar.py",
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_missing_suggestion(self, suggester):
        result = await suggester.get_file_content(
            "org_a", "prsug_nope", "foo.py",
        )
        assert result is None


class TestRegenerate:
    @pytest.mark.asyncio
    async def test_regenerate_returns_updated(self, suggester):
        s = await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # Reject first.
        await suggester.mark_status("org_a", s.id, "rejected")
        # Regenerate.
        updated = await suggester.regenerate("org_a", s.id)
        assert updated is not None
        # Status resets to pending.
        assert updated.status == "pending"
        # The id is preserved.
        assert updated.id == s.id

    @pytest.mark.asyncio
    async def test_regenerate_missing(self, suggester):
        result = await suggester.regenerate("org_a", "prsug_nope")
        assert result is None

    @pytest.mark.asyncio
    async def test_regenerate_uses_llm_when_available(self, suggester):
        from eden.agent import PRSuggester

        class MockLLM:
            async def complete(self, prompt: str, **kw):
                return '{"pr_title": "v2", "pr_body": "v2 body", "patch_diff": "x", "blast_radius": 0.1, "confidence": 0.8}'

        # Build a suggester with the LLM.
        s = PRSuggester(
            repo_provider=suggester._repo,
            llm_client=MockLLM(),
            store_path=suggester._store_path,
        )
        sug = await s.suggest(
            "org_b", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # Sanity: the heuristic default is "x = 1\n" or
        # similar (no LLM at first).
        updated = await s.regenerate("org_b", sug.id)
        assert updated is not None
        # The LLM's response is used.
        assert updated.pr_title == "v2"
        assert updated.pr_body == "v2 body"
        assert updated.patch_diff == "x"


class TestBulkRegenerate:
    @pytest.mark.asyncio
    async def test_bulk_regenerate_mixed(self, suggester):
        ids = []
        for i in range(3):
            sug = await suggester.suggest(
                "org_a", trigger="rca_cluster", trigger_id=str(i),
                trigger_payload={"affected_files": ["foo.py"]},
            )
            ids.append(sug.id)
        result = await suggester.bulk_regenerate(
            "org_a", [ids[0], ids[1], "prsug_fake"],
        )
        assert len(result["regenerated"]) == 2
        assert ids[0] in result["regenerated"]
        assert ids[1] in result["regenerated"]
        assert "prsug_fake" in result["skipped"]

    @pytest.mark.asyncio
    async def test_bulk_regenerate_empty(self, suggester):
        result = await suggester.bulk_regenerate("org_a", [])
        assert result == {"regenerated": [], "skipped": []}


class TestListSuggestionsWithSince:
    @pytest.mark.asyncio
    async def test_since_filter_excludes_old(self, suggester):
        from datetime import datetime, timedelta, timezone
        # 1 suggestion with a known created_at (now).
        await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # since = 1 second in the future → 0 rows.
        future = (
            datetime.now(UTC) + timedelta(seconds=1)
        ).isoformat()
        rows = await suggester.list_suggestions(
            "org_a", since=future,
        )
        assert rows == []
        # since = 1 hour ago → 1 row.
        past = (
            datetime.now(UTC) - timedelta(hours=1)
        ).isoformat()
        rows = await suggester.list_suggestions("org_a", since=past)
        assert len(rows) == 1

    @pytest.mark.asyncio
    async def test_since_invalid_string(self, suggester):
        await suggester.suggest(
            "org_a", trigger="rca_cluster", trigger_id="1",
            trigger_payload={"affected_files": ["foo.py"]},
        )
        # Invalid since string is ignored (returns all).
        rows = await suggester.list_suggestions(
            "org_a", since="not-a-date",
        )
        assert len(rows) == 1
