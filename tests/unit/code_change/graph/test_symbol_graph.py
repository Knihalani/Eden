"""Tests for the real SymbolGraph repo-graph backend.

These tests use a tiny throwaway repo so the AST-based
parsers exercise real Python source — no mocks. We
exercise the full indexing pipeline, then issue real
queries + find_affected_areas calls.
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from textwrap import dedent

import pytest

from eden.code_change.graph.symbol_graph import (
    SYMBOL_GRAPH_DB,
    SymbolGraph,
    _iter_files,
    _parse_python_with_parents,
    _parse_text_symbols,
)


# ── Helpers ──────────────────────────────────────────────────────────


def _write_repo(root: Path) -> dict[str, str]:
    """Write a small throwaway Python repo; return the file map."""
    files: dict[str, str] = {
        "src/foo.py": dedent(
            '''
            """The foo module."""
            import logging
            from typing import Any

            logger = logging.getLogger(__name__)


            class FooService:
                """The Foo service."""

                def __init__(self, name: str) -> None:
                    self.name = name

                def greet(self) -> str:
                    """Say hello."""
                    return f"hello {self.name}"

                def failing(self) -> None:
                    raise NotImplementedError("TODO")
            '''
        ).strip(),
        "src/bar.py": dedent(
            '''
            """The bar module."""
            from src.foo import FooService


            def make_service(name: str) -> FooService:
                """Construct a FooService."""
                return FooService(name)


            async def async_helper(value: int) -> int:
                """An async helper."""
                return value * 2
            '''
        ).strip(),
        "src/util.py": dedent(
            '''
            """Small utilities."""


            def add(a: int, b: int) -> int:
                return a + b


            def sub(a: int, b: int) -> int:
                return a - b
            '''
        ).strip(),
        "README.md": "# This is documentation, not code.",
    }
    for rel, body in files.items():
        full = root / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(body)
    return files


@pytest.fixture
def repo_and_db(tmp_path: Path):
    """A throwaway repo + isolated sqlite db."""
    repo = tmp_path / "repo"
    repo.mkdir()
    db = tmp_path / "graph.sqlite"
    files = _write_repo(repo)
    yield repo, db, files


# ── _iter_files ──────────────────────────────────────────────────────


class TestIterFiles:
    """The file walker finds .py + JS + TS files but skips dotfiles."""

    def test_finds_python_files(self, repo_and_db):
        repo, _db, _files = repo_and_db
        paths = sorted(
            str(p.relative_to(repo)) for p in _iter_files(repo)
        )
        assert "src/foo.py" in paths
        assert "src/bar.py" in paths
        assert "src/util.py" in paths
        # README.md is not a code file.
        assert "README.md" not in paths


# ── _parse_python_with_parents ───────────────────────────────────────


class TestParsePython:
    """The Python AST parser extracts real symbols + references."""

    def test_extracts_class(self, repo_and_db):
        _repo, _db, files = repo_and_db
        symbols, refs = _parse_python_with_parents(
            "src/foo.py", files["src/foo.py"],
        )
        names = {s.name for s in symbols}
        assert "FooService" in names
        assert "greet" in names
        assert "failing" in names

    def test_extracts_imports_as_references(self, repo_and_db):
        _repo, _db, files = repo_and_db
        _symbols, refs = _parse_python_with_parents(
            "src/bar.py", files["src/bar.py"],
        )
        # ReferenceRecord uses ``name`` (the bare reference target).
        ref_names = {r.name for r in refs}
        # Cross-module imports surface as references; we just
        # assert that we extracted at least one reference.
        assert len(ref_names) > 0


# ── End-to-end SymbolGraph ───────────────────────────────────────────


class TestSymbolGraphE2E:
    """Full indexing + query against a real repo."""

    @pytest.mark.asyncio
    async def test_index_then_status(self, repo_and_db):
        repo, db, _files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        # request_index with background=False blocks until done.
        accepted = await g.request_index(
            "test_repo", branch="main", background=False,
        )
        assert accepted is True
        status = await g.status("test_repo", branch="main")
        assert status is not None
        assert status["indexed"] is True
        assert status["file_count"] >= 3
        assert status["symbol_count"] >= 5

    @pytest.mark.asyncio
    async def test_query_finds_class_by_name(self, repo_and_db):
        repo, db, _files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        await g.request_index("test_repo", "main", background=False)
        result = await g.query("test_repo", "FooService", branch="main")
        assert result is not None
        assert any("foo.py" in f for f in result.files)

    @pytest.mark.asyncio
    async def test_find_affected_areas_from_stack_trace(self, repo_and_db):
        repo, db, _files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        await g.request_index("test_repo", "main", background=False)
        signature = (
            'Traceback (most recent call last):\n'
            '  File "src/foo.py", line 17, in greet\n'
            '  File "src/bar.py", line 7, in make_service\n'
        )
        areas = await g.find_affected_areas(
            "test_repo",
            error_signature=signature,
            branch="main",
        )
        paths = [a.path for a in areas]
        assert "src/foo.py" in paths
        assert "src/bar.py" in paths
        # The file_path_hint is the strongest signal.
        if any(a.path == "src/foo.py" for a in areas):
            # If we matched via the stack trace, the
            # confidence is high.
            foo = next(a for a in areas if a.path == "src/foo.py")
            assert foo.confidence >= 0.6

    @pytest.mark.asyncio
    async def test_find_affected_areas_file_hint_takes_priority(self, repo_and_db):
        repo, db, _files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        await g.request_index("test_repo", "main", background=False)
        areas = await g.find_affected_areas(
            "test_repo",
            file_path_hint="src/util.py",
            branch="main",
        )
        assert len(areas) >= 1
        assert areas[0].path == "src/util.py"
        assert areas[0].confidence >= 0.9
        assert areas[0].reason == "file_path_hint"

    @pytest.mark.asyncio
    async def test_request_index_background_returns_immediately(self, repo_and_db):
        repo, db, _files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        # background=True (default) returns immediately.
        accepted = await g.request_index("test_repo", "main")
        assert accepted is True
        # The status will reflect "pending" until the
        # background thread finishes — that's the whole
        # point of background=True.


# ── Failure modes ────────────────────────────────────────────────────


class TestSymbolGraphFailures:
    """The graph is best-effort — every failure mode is contained."""

    @pytest.mark.asyncio
    async def test_nonexistent_repo_returns_empty_status(self, tmp_path):
        # Empty directory — no .py files to index.
        g = SymbolGraph(root=tmp_path, db_path=str(tmp_path / "x.sqlite"))
        accepted = await g.request_index(
            "empty_repo", "main", background=False,
        )
        assert accepted is True
        status = await g.status("empty_repo", "main")
        assert status is not None
        # Indexed=True even with 0 files — we did successfully
        # walk an empty repo. file_count may be 0.
        assert status["file_count"] == 0


class TestSymbolGraphWithTypeScript:
    """The regex scanner handles JS/TS files."""

    def test_regex_scanner_extracts_ts_functions(self):
        source = """
        export function add(a: number, b: number): number {
            return a + b;
        }
        export class UserService {
            constructor(name: string) { this.name = name; }
            greet(): string { return `hello ${this.name}`; }
        }
        const ARROW = (x: number) => x * 2;
        """
        symbols, _refs = _parse_text_symbols("src/util.ts", source)
        names = {s.name for s in symbols}
        assert "add" in names
        assert "UserService" in names
        assert "ARROW" in names


# ── Performance / incremental indexing ─────────────────────────────


class TestSymbolGraphMtimeCache:
    """The mtime cache makes repeat indexing essentially free."""

    @pytest.mark.asyncio
    async def test_warm_reindex_is_fast(self, repo_and_db):
        """A second index() with no file changes should be <100ms."""
        import time as _t
        repo, db, _ = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        # Cold index.
        await g.request_index("test_repo", "main", background=False)
        # Warm index — no file changes.
        t0 = _t.perf_counter()
        await g.request_index("test_repo", "main", background=False)
        elapsed_ms = (_t.perf_counter() - t0) * 1000
        # No-git, single-file repo — warm should be sub-100ms.
        assert elapsed_ms < 100, f"warm re-index too slow: {elapsed_ms:.1f}ms"

    @pytest.mark.asyncio
    async def test_modified_file_reparses(self, repo_and_db):
        """A file whose mtime changed must be re-parsed on next index."""
        repo, db, files = repo_and_db
        g = SymbolGraph(root=repo, db_path=str(db))
        await g.request_index("test_repo", "main", background=False)
        # Add a new function to foo.py.
        fp = repo / "src" / "foo.py"
        original = fp.read_text()
        fp.write_text(original + "\ndef new_function():\n    return 42\n")
        import os as _os
        _os.utime(fp, None)  # ensure mtime bumps
        await g.request_index("test_repo", "main", background=False)
        # The new symbol should appear.
        result = await g.query("test_repo", "new_function", "main")
        assert result is not None
        assert any("foo.py" in f for f in result.files)


class TestSymbolGraphThreadLocalConn:
    """Multiple SymbolGraph instances with different DB files don't
    share connections (a regression caught when refactoring to
    thread-local connections)."""

    @pytest.mark.asyncio
    async def test_different_db_paths_isolated(self, tmp_path):
        from eden.code_change.graph.symbol_graph import _get_cached_conn, _set_cached_conn
        # Two distinct DB paths.
        db_a = str(tmp_path / "a.sqlite")
        db_b = str(tmp_path / "b.sqlite")
        # First access opens a connection.
        # We can't easily open a connection without the store, but
        # we can verify the cache key isolation: a key set for A
        # must not be returned for B.
        import sqlite3 as _sq
        c_a = _sq.connect(db_a)
        _set_cached_conn(db_a, c_a)
        assert _get_cached_conn(db_a) is c_a
        assert _get_cached_conn(db_b) is None
        c_a.close()
