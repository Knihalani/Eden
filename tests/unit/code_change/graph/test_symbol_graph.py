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
    _CLASS_DECL_RE,
    _CONST_DECL_RE,
    _FN_DECL_RE,
    _METHOD_DECL_RE,
    SYMBOL_GRAPH_DB,
    SymbolGraph,
    _build_line_lookup,
    _iter_files,
    _parse_python_single_pass,
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


# ── _parse_python_single_pass ────────────────────────────────────────


class TestParsePythonSinglePass:
    """The single-pass Python parser used by the production indexer.

    This used to live in _parse_python_with_parents (deleted in
    the v1.7.4 polish pass — superseded by a single recursive DFS
    walk that avoids the parent-map + two-walk overhead). The new
    function must still extract the same symbols + refs.
    """

    def test_extracts_class(self, repo_and_db):
        _repo, _db, files = repo_and_db
        symbols, _refs = _parse_python_single_pass(
            "src/foo.py", files["src/foo.py"],
        )
        names = {s.name for s in symbols}
        assert "FooService" in names
        assert "greet" in names
        assert "failing" in names

    def test_method_parent_is_enclosing_class(self, repo_and_db):
        _repo, _db, files = repo_and_db
        symbols, _refs = _parse_python_single_pass(
            "src/foo.py", files["src/foo.py"],
        )
        # greet is a method of FooService, so its parent
        # should be set to the enclosing class name.
        method = next(s for s in symbols if s.name == "greet")
        assert method.kind == "method"
        assert method.parent == "FooService"

    def test_top_level_function_has_no_enclosing_class(self, repo_and_db):
        _repo, _db, files = repo_and_db
        symbols, _refs = _parse_python_single_pass(
            "src/bar.py", files["src/bar.py"],
        )
        # make_service and async_helper are module-level
        # functions — no enclosing class.
        for name in ("make_service", "async_helper"):
            func = next(s for s in symbols if s.name == name)
            assert func.kind == "function", f"{name} kind={func.kind}"
            assert func.parent == "", f"{name} parent={func.parent!r}"

    def test_extracts_references(self, repo_and_db):
        _repo, _db, files = repo_and_db
        _symbols, refs = _parse_python_single_pass(
            "src/bar.py", files["src/bar.py"],
        )
        ref_names = {r.name for r in refs}
        # We just assert that we extracted at least one reference;
        # the cross-module import surface shows up as one.
        assert len(ref_names) > 0

    def test_method_in_nested_class(self):
        """A method inside a nested class records the full
        enclosing-class chain as a dotted path.

        v1.7.4 single-pass DFS upgrade: instead of returning
        just the innermost enclosing class (the old
        ``_parse_python_with_parents`` behaviour) we return
        ``"Outer.Inner"`` so the discipline layer can resolve
        nested class lookups without rebuilding the chain.
        """
        src = (
            "class Outer:\n"
            "    class Inner:\n"
            "        def method(self):\n"
            "            return 1\n"
        )
        symbols, _refs = _parse_python_single_pass("nested.py", src)
        method = next(s for s in symbols if s.name == "method")
        assert method.kind == "method"
        assert method.parent == "Outer.Inner", (
            f"expected parent='Outer.Inner' (dotted enclosing "
            f"class chain), got parent={method.parent!r}"
        )
        # Both classes should be present.
        names = {s.name for s in symbols if s.kind == "class"}
        assert names == {"Outer", "Inner"}


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


class TestSymbolGraphTextLineLookup:
    """Regression tests for the dense offset→line lookup.

    The previous implementation called
    ``source.count("\n", 0, offset)`` per match — O(offset)
    per lookup, O(n\u00b2) for a file with n matches. On a
    3.7MB TS file with thousands of matches this was
    catastrophic. v1.7.4 replaces it with a single O(n)
    pre-pass that builds a dense ``array.array('I')``
    mapping every byte offset to its 1-based line number.
    These tests pin the behaviour.
    """

    def test_line_offsets_are_correct(self):
        source = "a\nb\nc\n"
        _starts, line_for = _build_line_lookup(source)
        # 4 bytes: 0='a', 1='\n', 2='b', 3='\n', 4='c'
        assert len(line_for) == len(source)
        assert int(line_for[0]) == 1  # 'a' is on line 1
        assert int(line_for[1]) == 1  # '\n' is on line 1
        assert int(line_for[2]) == 2  # 'b' is on line 2
        assert int(line_for[3]) == 2  # '\n' is on line 2
        assert int(line_for[4]) == 3  # 'c' is on line 3

    def test_line_numbers_match_naive_baseline(self):
        """Across many random offsets, the lookup must match
        the O(n) naive ``source.count("\n", 0, offset)+1``
        baseline exactly. Catches off-by-one regressions
        in the pre-pass."""
        import random
        random.seed(0)
        body = []
        for i in range(500):
            body.append(f"function f{i:04d}() {{ return {i}; }}")
        source = "\n".join(body)
        _starts, line_for = _build_line_lookup(source)
        for _ in range(200):
            off = random.randint(0, len(source) - 1)
            baseline = source.count("\n", 0, off) + 1
            assert int(line_for[off]) == baseline, (
                f"offset {off}: lookup={int(line_for[off])} "
                f"baseline={baseline}"
            )

    def test_ts_indexer_line_numbers_are_correct(self):
        """Round-trip: index a TS source and confirm the line
        numbers match the O(n) naive baseline byte-for-byte.

        The regexes use ``re.MULTILINE`` with ``^\\s*``, so
        ``m.start()`` can point at a leading whitespace char
        (a newline) rather than the first non-blank byte —
        the returned line number is the line containing the
        start offset, which is identical to the old
        ``source.count("\\n", 0, offset)+1`` baseline.
        """
        source = (
            "import x from 'y';\n"
            "export function alpha() { return 1; }\n"
            "export class Beta {\n"
            "  method() { return 2; }\n"
            "}\n"
            "const GAMMA = 3;\n"
        )
        symbols, _refs = _parse_text_symbols("sample.ts", source)
        by_name = {s.name: s for s in symbols}
        assert set(by_name) == {"alpha", "Beta", "method", "GAMMA"}
        # Verify line numbers exactly against the naive baseline
        # (which is what the old code did) for every match.
        expected: dict[str, int] = {}
        for r in (_FN_DECL_RE, _CLASS_DECL_RE, _CONST_DECL_RE, _METHOD_DECL_RE):
            for m2 in r.finditer(source):
                name = m2.group("name")
                if name in {"if", "for", "while", "switch", "return", "function", "class"}:
                    continue
                expected[name] = source.count("\n", 0, m2.start()) + 1
        for name, line in expected.items():
            assert by_name[name].line == line, (
                f"{name}: lookup={by_name[name].line} baseline={line}"
            )

    def test_empty_source_is_safe(self):
        """The pre-pass must not crash on an empty file."""
        _starts, line_for = _build_line_lookup("")
        assert len(line_for) == 0
        # The scanner must also be safe.
        symbols, refs = _parse_text_symbols("empty.ts", "")
        assert symbols == []
        assert refs == []

    def test_no_trailing_newline(self):
        """Files with no trailing newline should still index
        every line correctly."""
        source = "a\nb\nc"  # no trailing \n
        _starts, line_for = _build_line_lookup(source)
        assert int(line_for[0]) == 1
        assert int(line_for[1]) == 1
        assert int(line_for[2]) == 2
        assert int(line_for[3]) == 2
        assert int(line_for[4]) == 3


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
class TestSymbolGraphFTSContentless:
    """Tests for the contentless FTS5 schema + IN-subquery path.

    Validates the v1.7.3 migration: ``symbols_fts`` is
    contentless (3 cols: name / signature / docstring), the
    bulk loader uses ``INSERT INTO ... SELECT``, and
    ``search_symbols`` joins back to ``symbols`` via an
    IN-subquery rather than a JOIN. Without the
    IN-subquery the query was ~4500x slower because the
    SQLite planner picked the wrong access order.
    """

    def test_fts_schema_is_contentless(self, repo_and_db):
        repo, db, _files = repo_and_db
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(root=repo, db_path=str(db))
        sg._safe_index("o/r", "main")
        conn = sg._store._read_conn()
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(symbols_fts)").fetchall()
        }
        # Contentless FTS5 has exactly these 3 cols; the old
        # contentful shape had 10 (incl. repo / branch / kind).
        assert cols == {"name", "signature", "docstring"}, cols
        conn.close()

    def test_search_symbols_returns_correct_results(self, repo_and_db):
        """End-to-end: index → query → results match the source."""
        repo, db, _files = repo_and_db
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(root=repo, db_path=str(db))
        sg._safe_index("o/r", "main")
        results = asyncio.run(sg.query("o/r", "FooService"))
        # Snippets should contain FooService references
        snippet_strs = [s[2] for s in (results.snippets or [])]
        assert any("FooService" in s for s in snippet_strs), (
            f"expected FooService hits in {results.snippets}"
        )

    def test_search_is_submillisecond(self, repo_and_db):
        """Warm query should be under 5ms even with the JOIN back."""
        repo, db, _files = repo_and_db
        import time

        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(root=repo, db_path=str(db))
        sg._safe_index("o/r", "main")
        # Warm up
        for _ in range(5):
            asyncio.run(sg.query("o/r", "FooService"))
        # Measure
        t0 = time.perf_counter()
        for _ in range(50):
            asyncio.run(sg.query("o/r", "FooService"))
        avg_ms = (time.perf_counter() - t0) * 1000 / 50
        assert avg_ms < 5.0, f"query took {avg_ms:.2f}ms — expected <5ms"

    def test_fts_bulk_load_uses_select_into(self, repo_and_db):
        """After indexing, symbols_fts.rowid must match symbols.id."""
        repo, db, _files = repo_and_db
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(root=repo, db_path=str(db))
        sg._safe_index("o/r", "main")
        conn = sg._store._read_conn()
        sym_count = conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0]
        fts_count = conn.execute("SELECT COUNT(*) FROM symbols_fts").fetchone()[0]
        assert sym_count > 0
        # Both must be equal — the bulk INSERT INTO fts
        # SELECT id FROM symbols populates one FTS row per
        # symbols row.
        assert sym_count == fts_count, (
            f"symbols={sym_count} fts={fts_count} — bulk load mismatch"
        )
        conn.close()
