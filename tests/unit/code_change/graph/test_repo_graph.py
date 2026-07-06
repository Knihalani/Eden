"""Tests for the repo-graph layer."""

from __future__ import annotations

import pytest

from eden.code_change.graph import (
    AffectedArea,
    GraphQueryResult,
    GreptileRepoGraph,
    LocalRepoGraph,
    SymbolGraph,
    get_default_repo_graph,
)
from eden.code_change.graph.factory import get_default_repo_graph as _factory_direct


class TestLocalRepoGraph:
    """The local fallback works without any credentials."""

    @pytest.mark.asyncio
    async def test_status_returns_indexed(self):
        graph = LocalRepoGraph()
        status = await graph.status("acme/agent")
        assert status is not None
        assert status["indexed"] is True
        assert status["status"] == "local"

    @pytest.mark.asyncio
    async def test_request_index_returns_true(self):
        graph = LocalRepoGraph()
        accepted = await graph.request_index("acme/agent")
        assert accepted is True

    @pytest.mark.asyncio
    async def test_query_extracts_paths(self):
        graph = LocalRepoGraph()
        result = await graph.query(
            "acme/agent",
            "Why does src/eden/foo.py and src/eden/bar.py raise?",
        )
        assert result is not None
        assert isinstance(result.files, list)
        # The local fallback extracts path-shaped tokens.
        assert "src/eden/foo.py" in result.files
        assert "src/eden/bar.py" in result.files

    @pytest.mark.asyncio
    async def test_find_affected_areas_from_stack_trace(self):
        graph = LocalRepoGraph()
        signature = (
            'Traceback (most recent call last):\n'
            '  File "src/eden/api/handler.py", line 42, in call_api\n'
            '  File "src/eden/db/postgres.py", line 17, in execute\n'
        )
        areas = await graph.find_affected_areas(
            "acme/agent",
            error_signature=signature,
        )
        assert isinstance(areas, list)
        paths = {a.path for a in areas}
        assert "src/eden/api/handler.py" in paths
        assert "src/eden/db/postgres.py" in paths
        # Symbols extracted.
        symbols = {a.symbol for a in areas if a.symbol}
        assert "call_api" in symbols
        assert "execute" in symbols

    @pytest.mark.asyncio
    async def test_find_affected_areas_with_path_hint(self):
        graph = LocalRepoGraph()
        areas = await graph.find_affected_areas(
            "acme/agent",
            file_path_hint="src/eden/important.py",
        )
        assert len(areas) >= 1
        assert areas[0].path == "src/eden/important.py"
        assert areas[0].confidence >= 0.5

    @pytest.mark.asyncio
    async def test_find_affected_areas_empty_inputs(self):
        graph = LocalRepoGraph()
        areas = await graph.find_affected_areas("acme/agent")
        assert areas == []


class TestFactorySelectsSymbolGraphByDefault:
    """Without credentials, the factory returns SymbolGraph.

    SymbolGraph is the new default — it doesn't need an
    API key and works offline. LocalRepoGraph remains
    available for callers that explicitly need it.
    """

    def test_no_credentials_returns_symbol(self, monkeypatch, tmp_path):
        monkeypatch.delenv("GREPTILE_API_KEY", raising=False)
        monkeypatch.setenv(
            "EDEN_SYMBOL_GRAPH_DB", str(tmp_path / "sg.sqlite"),
        )
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(tmp_path))
        graph = _factory_direct()
        assert graph.name == "symbol"


class TestFactoryGreptileNotDefault:
    """Greptile is an optional upgrade path, not the default.

    The user explicitly told us Greptile was an example —
    the real default is SymbolGraph. Setting
    ``GREPTILE_API_KEY`` no longer changes the factory
    result; you must instantiate :class:`GreptileRepoGraph`
    directly if you want the hosted backend.
    """

    def test_with_credentials_still_returns_symbol(
        self, monkeypatch, tmp_path,
    ):
        monkeypatch.setenv("GREPTILE_API_KEY", "test-key-1234")
        monkeypatch.setenv(
            "EDEN_SYMBOL_GRAPH_DB", str(tmp_path / "sg.sqlite"),
        )
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(tmp_path))
        graph = _factory_direct()
        assert graph.name == "symbol"


class TestGreptileRepoGraph:
    """The Greptile client is constructable + raises on missing key."""

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="non-empty api_key"):
            GreptileRepoGraph(api_key="")

    def test_constructs_with_key(self):
        client = GreptileRepoGraph(api_key="test-key-1234")
        assert client.name == "greptile"

    @pytest.mark.asyncio
    async def test_request_index_invalid_key_fails_gracefully(self, monkeypatch):
        """An invalid key should return False, not raise."""
        # Override base URL to a non-existent host so the
        # request fails fast without depending on the real
        # Greptile API.
        client = GreptileRepoGraph(
            api_key="test-key-1234",
            base_url="http://127.0.0.1:1",
            timeout=1.0,
        )
        accepted = await client.request_index("acme/agent")
        assert accepted is False


class TestAffectedArea:
    """The AffectedArea dataclass is well-formed."""

    def test_default_confidence(self):
        area = AffectedArea(path="x.py")
        assert area.confidence == 0.0
        assert area.symbol == ""
        assert area.reason == ""

    def test_full_construction(self):
        area = AffectedArea(
            path="x.py",
            symbol="foo",
            confidence=0.7,
            reason="stack_trace_match",
        )
        assert area.symbol == "foo"


class TestGraphQueryResult:
    """The GraphQueryResult dataclass is well-formed."""

    def test_default(self):
        result = GraphQueryResult()
        assert result.answer == ""
        assert result.snippets == []
        assert result.files == []
        assert result.raw == {}


class TestSymbolGraph:
    """The SymbolGraph is the new default — real, in-process, persistent."""

    @pytest.fixture
    def tmp_repo(self, tmp_path):
        """A tiny fake repo with one Python and one TS file."""
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "foo.py").write_text(
            "def greet(name: str) -> str:\n"
            '    """Return a greeting."""\n'
            '    return f"hello, {name}"\n'
            "\n"
            "def helper() -> int:\n"
            "    return 42\n"
            "\n"
            "class Widget:\n"
            "    def render(self) -> str:\n"
            "        return greet('world')\n",
            encoding="utf-8",
        )
        (tmp_path / "src" / "bar.ts").write_text(
            "export function ping(): string {\n"
            "    return 'pong';\n"
            "}\n"
            "export class Echo {\n"
            "    speak(input: string): string {\n"
            "        return input;\n"
            "    }\n"
            "}\n",
            encoding="utf-8",
        )
        return tmp_path

    @pytest.mark.asyncio
    async def test_indexes_python_and_ts(self, tmp_repo, tmp_path):
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        ok = await sg.request_index("acme/agent", background=False)
        assert ok is True
        st = await sg.status("acme/agent")
        assert st is not None
        assert st["indexed"] is True
        assert st["file_count"] >= 2
        assert st["symbol_count"] >= 5  # 3 py + 3 ts (incl. class+method)

    @pytest.mark.asyncio
    async def test_query_finds_python_symbol(self, tmp_repo, tmp_path):
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        result = await sg.query("acme/agent", "greet", branch="main")
        assert result is not None
        assert any("foo.py" in p for p in result.files)

    @pytest.mark.asyncio
    async def test_query_finds_typescript_symbol(self, tmp_repo, tmp_path):
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        result = await sg.query("acme/agent", "ping", branch="main")
        assert result is not None
        assert any("bar.ts" in p for p in result.files)

    @pytest.mark.asyncio
    async def test_find_affected_areas_from_path_hint(
        self, tmp_repo, tmp_path,
    ):
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        areas = await sg.find_affected_areas(
            "acme/agent",
            file_path_hint="src/foo.py",
            branch="main",
        )
        assert len(areas) >= 1
        assert areas[0].path == "src/foo.py"
        assert areas[0].reason == "file_path_hint"

    @pytest.mark.asyncio
    async def test_find_affected_areas_from_stack_trace(
        self, tmp_repo, tmp_path,
    ):
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        sig = (
            'File "src/foo.py", line 1, in greet\n'
        )
        areas = await sg.find_affected_areas(
            "acme/agent", error_signature=sig, branch="main",
        )
        paths = {a.path for a in areas}
        assert "src/foo.py" in paths

    @pytest.mark.asyncio
    async def test_find_affected_areas_from_symbol_refs(
        self, tmp_repo, tmp_path,
    ):
        """A reference to ``greet`` from ``Widget.render`` should
        surface ``foo.py`` as affected."""
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        areas = await sg.find_affected_areas(
            "acme/agent",
            error_signature="greet failed",
            branch="main",
        )
        paths = {a.path for a in areas}
        # Widget.render() references greet — so foo.py should
        # appear in the affected-area list.
        assert "src/foo.py" in paths

    @pytest.mark.asyncio
    async def test_incremental_noop_when_sha_unchanged(
        self, tmp_repo, tmp_path,
    ):
        """A second index call with the same SHA should be a no-op."""
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_repo, db_path=str(tmp_path / "sg.sqlite"),
        )
        await sg.request_index("acme/agent", background=False)
        st1 = await sg.status("acme/agent")
        await sg.request_index("acme/agent", background=False)
        st2 = await sg.status("acme/agent")
        assert st1 is not None and st2 is not None
        assert st2["file_count"] == st1["file_count"]

    @pytest.mark.asyncio
    async def test_no_crash_on_missing_repo(self, tmp_path):
        """A repo path that doesn't exist should not crash."""
        from eden.code_change.graph.symbol_graph import SymbolGraph
        sg = SymbolGraph(
            root=tmp_path / "does-not-exist",
            db_path=str(tmp_path / "sg.sqlite"),
        )
        # These must all be best-effort — never raise.
        st = await sg.status("acme/agent")
        assert st is not None
        # The index entry doesn't exist yet so indexed=False.
        assert st["indexed"] is False
        ok = await sg.request_index(
            "acme/agent", background=False,
        )
        # No files found, but the call should still return True.
        assert ok is True
        areas = await sg.find_affected_areas("acme/agent")
        assert areas == []
