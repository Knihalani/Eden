"""The suggestion store must not be destroyed or silently desynced by a write.

``_replace_suggestion`` and ``_update_suggestion`` both rewrote the whole JSONL
store with ``open(path, "w")`` and both wrapped the write in
``except Exception: logger.debug(...)``. That combination produced two distinct
failures:

1. **Truncation loss.** ``open(path, "w")`` truncates on entry, so a crash or a
   full disk between the truncate and the final ``writelines`` left the store
   empty -- losing every suggestion for every org, not just the one being
   edited.

2. **Split-brain.** ``mark_opened`` / ``mark_status`` treat a non-``None``
   return from ``_update_suggestion`` as "persisted" and go on to flip the row
   in Postgres. With the write error swallowed, the API returned "opened",
   Postgres agreed, and the JSONL still said "pending".

The tests below drive the real ``PRSuggester``, not the helper, because the
helper being correct proves nothing about whether the call site uses it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest

from eden.agent.pr_suggester import PRSuggester


class _StubRepo:
    """Minimal RepoProvider — these tests never touch the repo."""

    async def read_file(self, path: str) -> str | None:  # pragma: no cover
        return None

    async def list_files(self, glob: str) -> list[str]:  # pragma: no cover
        return []


def _row(suggestion_id: str, org_id: str = "org-1", status: str = "pending") -> str:
    return json.dumps(
        {
            "id": suggestion_id,
            "org_id": org_id,
            "trigger": "regression",
            "trigger_id": "t-1",
            "trigger_summary": "summary",
            "files": [],
            "patch_diff": "",
            "pr_title": "title",
            "pr_body": "body",
            "blast_radius": "low",
            "confidence": 0.5,
            "status": status,
            "created_at": "2026-07-01T00:00:00+00:00",
            "opened_pr_number": None,
        }
    )


@pytest.fixture
def store(tmp_path: Path) -> Path:
    path = tmp_path / "pr_suggestions.jsonl"
    path.write_text(
        "\n".join([_row("s-1"), _row("s-2"), _row("s-3")]) + "\n", encoding="utf-8"
    )
    return path


@pytest.fixture
def suggester(store: Path) -> PRSuggester:
    return PRSuggester(
        repo_provider=_StubRepo(),  # type: ignore[arg-type]
        llm_client=object(),  # type: ignore[arg-type]
        store_path=str(store),
    )


class TestUpdateIsDurable:
    def test_a_successful_update_rewrites_only_the_target_row(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        found = suggester._update_suggestion("org-1", "s-2", status="merged")
        assert found is not None

        rows = [json.loads(x) for x in store.read_text(encoding="utf-8").splitlines()]
        assert [r["id"] for r in rows] == ["s-1", "s-2", "s-3"], "row order changed"
        assert [r["status"] for r in rows] == ["pending", "merged", "pending"]

    def test_a_failed_write_does_not_truncate_the_store(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        before = store.read_text(encoding="utf-8")

        with patch("os.replace", side_effect=OSError(28, "No space left")):
            with pytest.raises(OSError):
                suggester._update_suggestion("org-1", "s-2", status="merged")

        assert store.read_text(encoding="utf-8") == before, (
            "a failed rewrite lost the other suggestions"
        )

    def test_a_failed_write_does_not_report_success(
        self, suggester: PRSuggester
    ) -> None:
        """Returning ``found`` after a failed write is what desynced Postgres."""
        with patch("os.replace", side_effect=OSError("disk")):
            with pytest.raises(OSError):
                suggester._update_suggestion("org-1", "s-2", status="merged")

    def test_a_missing_id_still_returns_none_without_writing(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        before = store.read_text(encoding="utf-8")
        with patch("os.replace", side_effect=AssertionError("must not write")):
            assert suggester._update_suggestion("org-1", "nope", status="merged") is None
        assert store.read_text(encoding="utf-8") == before

    def test_another_orgs_row_is_not_updatable(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        assert suggester._update_suggestion("org-2", "s-1", status="merged") is None
        rows = [json.loads(x) for x in store.read_text(encoding="utf-8").splitlines()]
        assert all(r["status"] == "pending" for r in rows)


class TestMarkStatusDoesNotDesyncPostgres:
    @pytest.mark.asyncio
    async def test_postgres_is_not_touched_when_the_file_write_fails(
        self, suggester: PRSuggester
    ) -> None:
        """The concrete split-brain: PG says "merged", the file says "pending"."""
        pg_calls: list[Any] = []

        async def _record(*args: Any, **kwargs: Any) -> None:
            pg_calls.append((args, kwargs))

        with (
            patch.object(suggester, "_update_proposed_patches_status", _record),
            patch("os.replace", side_effect=OSError("disk")),
        ):
            with pytest.raises(OSError):
                await suggester.mark_status("org-1", "s-2", "merged")

        assert pg_calls == [], (
            "Postgres was updated even though the JSONL write failed"
        )

    @pytest.mark.asyncio
    async def test_postgres_is_updated_on_a_successful_write(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        pg_calls: list[Any] = []

        async def _record(*args: Any, **kwargs: Any) -> None:
            pg_calls.append((args, kwargs))

        with patch.object(suggester, "_update_proposed_patches_status", _record):
            got = await suggester.mark_status("org-1", "s-2", "merged")

        assert got is not None
        assert len(pg_calls) == 1
        rows = [json.loads(x) for x in store.read_text(encoding="utf-8").splitlines()]
        assert {r["id"]: r["status"] for r in rows}["s-2"] == "merged"


class TestReplaceIsDurable:
    def test_a_failed_replace_keeps_the_previous_store(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        from eden.agent.pr_suggester import _suggestion_from_dict

        before = store.read_text(encoding="utf-8")
        original = _suggestion_from_dict(json.loads(_row("s-2")))

        with patch("os.replace", side_effect=OSError("disk")):
            with pytest.raises(OSError):
                suggester._replace_suggestion(original)

        assert store.read_text(encoding="utf-8") == before

    def test_no_temp_files_are_left_in_the_store_directory(
        self, suggester: PRSuggester, store: Path
    ) -> None:
        with patch("os.replace", side_effect=OSError("disk")):
            with pytest.raises(OSError):
                suggester._update_suggestion("org-1", "s-2", status="merged")

        assert [p.name for p in store.parent.iterdir()] == [store.name]
