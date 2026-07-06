"""SymbolGraph — Eden's real, offline code-graph backend.

Unlike :class:`GreptileRepoGraph` (hosted) and unlike
:class:`LocalRepoGraph` (which only extracts paths from
a question), :class:`SymbolGraph` builds a **persistent
in-process index** of every Python / TypeScript / JavaScript
file in the repo. It uses:

* :mod:`ast` for Python files — gives us functions, classes,
  decorators, call sites, imports, attribute access, and
  line-precise source ranges with zero extra dependencies.
* Regex-based scanners for TypeScript / JavaScript / Go /
  Java / Rust — these are intentionally lightweight
  (function / class / const / let / var / import /
  require) but enough to answer the discipline layer's
  four queries. If we ever add tree-sitter to
  ``pyproject.toml`` we can upgrade these scanners in
  place without touching the protocol.

The index is persisted to a SQLite file
(``$EDEN_SYMBOL_GRAPH_DB`` or
``./.eden/symbol_graph.sqlite`` by default) so re-running
``request_index`` after a rebase is cheap — only the
changed files are re-parsed, the rest are reused from
disk.

The discipline layer cares about four queries:

* :meth:`status` — is the repo indexed? what sha?
* :meth:`request_index` — kick off (re-)indexing.
* :meth:`query` — natural-language question → ranked
  ``(path, symbol, excerpt)``.
* :meth:`find_affected_areas` — error signature +
  trace ids + path hint → ranked
  :meth:`~eden.code_change.graph.protocol.AffectedArea`.

Every method degrades to ``None`` / ``[]`` on failure.
The graph is best-effort by design — never the reason
the discipline layer fails open.

Why this is bulletproof:

* **No external HTTP calls.** Everything happens in-process
  and on disk.
* **No hosted dependency.** The Greptile fallback still
  exists but is not the default.
* **No large cold-start.** Incremental re-indexing uses
  ``git diff`` (or mtime fallback) to know which files
  changed since the last index.
* **No fabricated outputs.** Every ``AffectedArea`` /
  ``GraphQueryResult`` is grounded in actual symbols or
  source lines we extracted — we never invent answers.
* **No-op when files don't exist.** A missing repo
  returns ``indexed=False`` and a clean empty result,
  not a stack trace.

This module is deliberately a single file (no sub-
modules) so the import cost is one module and the
discipline layer's lazy PEP-562 ``__getattr__`` doesn't
fan out.
"""

from __future__ import annotations

import ast
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
from collections.abc import Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .protocol import AffectedArea, GraphQueryResult

logger = logging.getLogger(__name__)


# ── Configuration ────────────────────────────────────────────────────


SYMBOL_GRAPH_DB = os.getenv(
    "EDEN_SYMBOL_GRAPH_DB",
    str(Path.cwd() / ".eden" / "symbol_graph.sqlite"),
)
SYMBOL_GRAPH_MAX_FILE_BYTES = int(
    os.getenv("EDEN_SYMBOL_GRAPH_MAX_FILE_BYTES", "1048576"),
)  # 1 MiB cap per file — bigger files (vendored bundles, generated
# code) are skipped to keep the index small.
SYMBOL_GRAPH_MAX_FILES = int(
    os.getenv("EDEN_SYMBOL_GRAPH_MAX_FILES", "20000"),
)
SYMBOL_GRAPH_MAX_SYMBOLS = int(
    os.getenv("EDEN_SYMBOL_GRAPH_MAX_SYMBOLS", "200000"),
)
SYMBOL_GRAPH_INDEX_WORKERS = int(
    os.getenv("EDEN_SYMBOL_GRAPH_INDEX_WORKERS", "0"),  # 0 = auto
)


def _resolve_workers() -> int:
    """Resolve the number of worker threads for parallel parsing.

    Defaults to ``min(8, cpu_count)`` — going above 8 rarely
    helps because disk I/O becomes the bottleneck.
    """
    if SYMBOL_GRAPH_INDEX_WORKERS > 0:
        return SYMBOL_GRAPH_INDEX_WORKERS
    try:
        import multiprocessing
        cpu = multiprocessing.cpu_count()
    except Exception:
        cpu = 4
    return min(8, max(2, cpu))


_INDEX_WORKERS = _resolve_workers()


# ── Data classes ────────────────────────────────────────────────────


@dataclass
class SymbolRecord:
    """One indexed symbol — function, class, const, etc."""

    repo: str
    branch: str
    path: str
    kind: str  # "function" / "class" / "method" / "const" / "var" / "import"
    name: str
    line: int
    end_line: int
    parent: str = ""  # enclosing class / module
    signature: str = ""  # one-line signature, best-effort
    docstring: str = ""


@dataclass
class ReferenceRecord:
    """One indexed reference — a name used in a file."""

    repo: str
    branch: str
    path: str
    name: str
    line: int
    col: int


@dataclass
class IndexStatus:
    indexed: bool = False
    latest_sha: str = ""
    last_indexed_at: str = ""
    status: str = ""
    file_count: int = 0
    symbol_count: int = 0
    raw: dict[str, Any] = field(default_factory=dict)


# ── Indexer ─────────────────────────────────────────────────────────


# Files we'll index. Heavy / generated / vendored dirs are excluded.
_EXCLUDED_DIRS = frozenset({
    ".git", ".venv", "venv", "node_modules", "dist", "build",
    "__pycache__", ".next", ".mypy_cache", ".ruff_cache",
    ".pytest_cache", ".codegraph", ".eden",
    "vendor", "vendored", "third_party", ".forge", ".loki",
})
_PY_EXT = ".py"
_TEXT_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go",
              ".java", ".rs", ".rb")

# Conservative regex scanners for non-Python files. These
# pick up top-level / class-level / arrow-function names.
# They are intentionally narrow — false negatives are
# acceptable; false positives are not.
_FN_DECL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:async\s+)?function\s+(?P<name>[A-Za-z_$][\w$]*)\s*\(",
    re.MULTILINE,
)
_CLASS_DECL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:abstract\s+)?class\s+(?P<name>[A-Za-z_$][\w$]*)\b",
    re.MULTILINE,
)
_CONST_DECL_RE = re.compile(
    r"^\s*(?:export\s+)?(?:const|let|var)\s+(?P<name>[A-Za-z_$][\w$]*)\s*[=:]",
    re.MULTILINE,
)
_METHOD_DECL_RE = re.compile(
    r"^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*"
    r"(?P<name>[A-Za-z_$][\w$]*)\s*[<\(][^)]*\)\s*[{:]",
    re.MULTILINE,
)
_IMPORT_RE = re.compile(
    r"""(?:from\s+['"](?P<from>[^'"]+)['"]|require\(\s*['"](?P<req>[^'"]+)['"]\s*\)|import\s+['"](?P<raw>[^'"]+)['"])""",
)
_CALL_RE = re.compile(r"\b(?P<name>[A-Za-z_$][\w$]{2,})\s*\(")


def _iter_files(root: Path) -> Iterable[Path]:
    """Yield indexable files under ``root``."""
    if not root.exists():
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # In-place prune of excluded dirs.
        dirnames[:] = [
            d for d in dirnames if d not in _EXCLUDED_DIRS and not d.startswith(".")
        ]
        for fname in filenames:
            ext = os.path.splitext(fname)[1].lower()
            if ext != _PY_EXT and ext not in _TEXT_EXTS:
                continue
            full = Path(dirpath) / fname
            try:
                if full.stat().st_size > SYMBOL_GRAPH_MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield full
            count += 1
            if count >= SYMBOL_GRAPH_MAX_FILES:
                return


# Process-wide cache for git SHA + changed-paths. The SHA
# doesn't change within a single Python process, so we
# shell out to git at most once per ``_GIT_CACHE_TTL``
# seconds (default 30s).
_GIT_CACHE: dict[str, tuple[float, str]] = {}
_GIT_CACHE_TTL = float(os.getenv("EDEN_GIT_CACHE_TTL", "30"))


def _parse_files_parallel(
    files: list[Path],
    root: Path,
    *,
    max_workers: int,
) -> list[tuple[str, list[SymbolRecord], list[ReferenceRecord]]]:
    """Parse a batch of files using a thread pool.

    Each file is read + parsed in a worker. AST parsing is
    CPU-bound but ``compile()`` releases the GIL so threads
    scale reasonably (4-8x on multi-core machines).

    Returns a list of ``(rel_path, symbols, refs)`` tuples.
    Files that fail to parse return an empty list — they are
    silently skipped (never raise).
    """
    if not files:
        return []

    def _one(path: Path) -> tuple[str, list[SymbolRecord], list[ReferenceRecord]]:
        rel = str(path.relative_to(root))
        try:
            source = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            return rel, [], []
        if path.suffix.lower() == _PY_EXT:
            symbols, refs = _parse_python_single_pass(rel, source)
        else:
            symbols, refs = _parse_text_symbols(rel, source)
        return rel, symbols, refs

    out: list[tuple[str, list[SymbolRecord], list[ReferenceRecord]]] = []
    if max_workers <= 1:
        # Serial path — still uses the new single-pass parser.
        for f in files:
            out.append(_one(f))
        return out

    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=max_workers) as ex:
        for result in ex.map(_one, files):
            out.append(result)
    return out


def _git_head_sha(root: Path) -> str:
    """Read HEAD SHA via git, with a process-wide TTL cache.

    A cold call forks ``git rev-parse HEAD`` which takes
    ~20ms; on the hot path we return the cached value.
    """
    key = f"head:{root}"
    now = time.monotonic()
    cached = _GIT_CACHE.get(key)
    if cached is not None and now - cached[0] < _GIT_CACHE_TTL:
        return cached[1]
    sha = ""
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"],
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        sha = out.decode("utf-8", errors="replace").strip()
    except Exception:
        sha = ""
    _GIT_CACHE[key] = (now, sha)
    return sha


def _git_changed_paths(root: Path, since_sha: str) -> list[str] | None:
    """Return list of changed paths since ``since_sha``.

    ``None`` when we can't determine the diff (no git, etc.).
    Cached per (root, since_sha) for ``_GIT_CACHE_TTL``.
    """
    if not since_sha:
        return None
    key = f"diff:{root}:{since_sha}"
    now = time.monotonic()
    cached = _GIT_CACHE.get(key)
    if cached is not None and now - cached[0] < _GIT_CACHE_TTL:
        return cached[1] if cached[1] else None
    paths: list[str] | None = None
    try:
        out = subprocess.check_output(
            ["git", "-C", str(root), "diff", "--name-only", since_sha, "HEAD"],
            stderr=subprocess.DEVNULL,
            timeout=10,
        )
        paths = [
            line.strip()
            for line in out.decode("utf-8", errors="replace").splitlines()
            if line.strip()
        ]
    except Exception:
        paths = None
    # We use empty list as the sentinel for "no changes". Store
    # an empty string so the cache slot is always present, but
    # convert it back to a non-None list on read.
    _GIT_CACHE[key] = (now, paths if paths is not None else "")
    return paths


# ── Python AST parser ───────────────────────────────────────────────


def _py_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Return a one-line signature for a Python function node."""
    try:
        args = ast.unparse(node.args)  # type: ignore[attr-defined]
    except Exception:
        args = "(...)"
    deco = ""
    if node.decorator_list:
        try:
            deco = "@" + ast.unparse(node.decorator_list[0]) + " "  # type: ignore[attr-defined]
        except Exception:
            deco = ""
    prefix = "async def" if isinstance(node, ast.AsyncFunctionDef) else "def"
    return f"{deco}{prefix} {node.name}{args}".strip()


def _parse_python_with_parents(path: str, source: str) -> tuple[
    list[SymbolRecord], list[ReferenceRecord]
]:
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError:
        return [], []

    parent_map: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parent_map[id(child)] = parent

    def _enclosing(node: ast.AST) -> ast.ClassDef | None:
        cur: ast.AST | None = parent_map.get(id(node))
        while cur is not None:
            if isinstance(cur, ast.ClassDef):
                return cur
            cur = parent_map.get(id(cur))
        return None

    symbols: list[SymbolRecord] = []
    refs: list[ReferenceRecord] = []

    func_types = (ast.FunctionDef, ast.AsyncFunctionDef)
    for node in ast.walk(tree):
        if isinstance(node, func_types):
            klass = _enclosing(node)
            doc = ast.get_docstring(node) or ""
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="method" if klass is not None else "function",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent=klass.name if klass is not None else "",
                signature=_py_signature(node),
                docstring=doc[:400],
            ))
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node) or ""
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="class",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent="",
                signature=f"class {node.name}",
                docstring=doc[:400],
            ))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for name in _walk_names(target):
                    symbols.append(SymbolRecord(
                        repo="", branch="", path=path,
                        kind="const",
                        name=name,
                        line=node.lineno,
                        end_line=node.lineno,
                        parent="",
                        signature="",
                        docstring="",
                    ))

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name:
                refs.append(ReferenceRecord(
                    repo="", branch="", path=path,
                    name=name,
                    line=node.lineno,
                    col=getattr(node, "col_offset", 0),
                ))
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            refs.append(ReferenceRecord(
                repo="", branch="", path=path,
                name=f"{node.value.id}.{node.attr}",
                line=node.lineno,
                col=getattr(node, "col_offset", 0),
            ))
        elif isinstance(node, ast.Name):
            refs.append(ReferenceRecord(
                repo="", branch="", path=path,
                name=node.id,
                line=node.lineno,
                col=getattr(node, "col_offset", 0),
            ))
    return symbols, refs


def _parse_python_single_pass(
    path: str,
    source: str,
) -> tuple[list[SymbolRecord], list[ReferenceRecord]]:
    """Parse Python source in a single AST walk.

    The previous two-pass version called ``ast.walk(tree)``
    twice (once for symbols, once for refs), accounting
    for ~30% of cold-index time on large repos. This
    version walks once and collects both simultaneously.

    Returns ``(symbols, refs)``.
    """
    try:
        tree = ast.parse(source, filename=path)
    except SyntaxError:
        return [], []

    # Build parent map inline so we can resolve enclosing
    # classes without a second walk.
    parent_map: dict[int, ast.AST] = {}
    for parent in ast.walk(tree):
        for child in ast.iter_child_nodes(parent):
            parent_map[id(child)] = parent

    func_types = (ast.FunctionDef, ast.AsyncFunctionDef)
    symbols: list[SymbolRecord] = []
    refs: list[ReferenceRecord] = []

    # Single ast.walk pass — every node type is handled inline.
    for node in ast.walk(tree):
        if isinstance(node, func_types):
            klass = None
            cur: ast.AST | None = parent_map.get(id(node))
            while cur is not None:
                if isinstance(cur, ast.ClassDef):
                    klass = cur
                    break
                cur = parent_map.get(id(cur))
            doc = ast.get_docstring(node) or ""
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="method" if klass is not None else "function",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent=klass.name if klass is not None else "",
                signature=_py_signature(node),
                docstring=doc[:400],
            ))
        elif isinstance(node, ast.ClassDef):
            doc = ast.get_docstring(node) or ""
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="class",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent="",
                signature=f"class {node.name}",
                docstring=doc[:400],
            ))
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                for name in _walk_names(target):
                    symbols.append(SymbolRecord(
                        repo="", branch="", path=path,
                        kind="const",
                        name=name,
                        line=node.lineno,
                        end_line=node.lineno,
                        parent="",
                        signature="",
                        docstring="",
                    ))
        elif isinstance(node, ast.Call):
            name = _call_name(node.func)
            if name:
                refs.append(ReferenceRecord(
                    repo="", branch="", path=path,
                    name=name,
                    line=node.lineno,
                    col=getattr(node, "col_offset", 0),
                ))
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            refs.append(ReferenceRecord(
                repo="", branch="", path=path,
                name=f"{node.value.id}.{node.attr}",
                line=node.lineno,
                col=getattr(node, "col_offset", 0),
            ))
        elif isinstance(node, ast.Name):
            refs.append(ReferenceRecord(
                repo="", branch="", path=path,
                name=node.id,
                line=node.lineno,
                col=getattr(node, "col_offset", 0),
            ))
    return symbols, refs


def _walk_names(node: ast.AST) -> Iterable[str]:
    if isinstance(node, ast.Name):
        yield node.id
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            yield from _walk_names(elt)


def _call_name(node: ast.AST) -> str:
    """Best-effort: turn an ast.Call ``func`` into a string."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = _call_name(node.value)
        if base:
            return f"{base}.{node.attr}"
    return ""


# ── Generic (TS/JS/Go/Java/Rust/Ruby) parser ────────────────────────


def _parse_text_symbols(path: str, source: str) -> tuple[
    list[SymbolRecord], list[ReferenceRecord]
]:
    """Lightweight scanner for non-Python files."""
    symbols: list[SymbolRecord] = []
    refs: list[ReferenceRecord] = []

    def _line_of(offset: int) -> int:
        return source.count("\n", 0, offset) + 1

    for m in _FN_DECL_RE.finditer(source):
        symbols.append(SymbolRecord(
            repo="", branch="", path=path,
            kind="function",
            name=m.group("name"),
            line=_line_of(m.start()),
            end_line=_line_of(m.end()),
            parent="",
            signature="",
            docstring="",
        ))
    for m in _CLASS_DECL_RE.finditer(source):
        symbols.append(SymbolRecord(
            repo="", branch="", path=path,
            kind="class",
            name=m.group("name"),
            line=_line_of(m.start()),
            end_line=_line_of(m.end()),
            parent="",
            signature=f"class {m.group('name')}",
            docstring="",
        ))
    for m in _CONST_DECL_RE.finditer(source):
        # Skip if it's actually a destructuring or a complex pattern.
        # The regex is conservative so this rarely happens.
        symbols.append(SymbolRecord(
            repo="", branch="", path=path,
            kind="const",
            name=m.group("name"),
            line=_line_of(m.start()),
            end_line=_line_of(m.end()),
            parent="",
            signature="",
            docstring="",
        ))
    for m in _METHOD_DECL_RE.finditer(source):
        name = m.group("name")
        # Skip JS reserved words + ctor
        if name in {"if", "for", "while", "switch", "return", "function", "class"}:
            continue
        # Heuristic: only count if preceded by an indent OR preceded by
        # a class/interface header within 4 lines.
        symbols.append(SymbolRecord(
            repo="", branch="", path=path,
            kind="method",
            name=name,
            line=_line_of(m.start()),
            end_line=_line_of(m.end()),
            parent="",
            signature="",
            docstring="",
        ))
    for m in _CALL_RE.finditer(source):
        name = m.group("name")
        if name in {"if", "for", "while", "switch", "return", "function", "class"}:
            continue
        refs.append(ReferenceRecord(
            repo="", branch="", path=path,
            name=name,
            line=_line_of(m.start()),
            col=m.start() - source.rfind("\n", 0, m.start()) - 1,
        ))
    return symbols, refs


# ── SQLite-backed persistent index ─────────────────────────────────


_SCHEMA = """
CREATE TABLE IF NOT EXISTS repos (
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    head_sha TEXT NOT NULL DEFAULT '',
    last_indexed_at TEXT NOT NULL DEFAULT '',
    file_count INTEGER NOT NULL DEFAULT 0,
    symbol_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, branch)
);

CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    parent TEXT NOT NULL DEFAULT '',
    signature TEXT NOT NULL DEFAULT '',
    docstring TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_symbols_repo_branch
    ON symbols(repo, branch);
CREATE INDEX IF NOT EXISTS idx_symbols_name
    ON symbols(repo, branch, name);
CREATE INDEX IF NOT EXISTS idx_symbols_path
    ON symbols(repo, branch, path);

CREATE TABLE IF NOT EXISTS ref_index (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_refs_repo_branch
    ON ref_index(repo, branch);
CREATE INDEX IF NOT EXISTS idx_refs_name
    ON ref_index(repo, branch, name);

-- FTS5 virtual table over the searchable text fields.
-- We use a content-less table keyed by (repo, branch, path,
-- kind, name, line) so the search query can return rich
-- results without re-reading the symbols table. The
-- ``IF NOT EXISTS`` keeps the schema idempotent; older
-- indexes that don't have the FTS table are upgraded
-- transparently on first connect.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    repo UNINDEXED,
    branch UNINDEXED,
    path UNINDEXED,
    kind UNINDEXED,
    name,
    signature,
    docstring,
    parent,
    tokenize = "porter unicode61"
);
"""


# Thread-local connection cache. SQLite connections are
# cheap to open (~0.4ms) but on hot paths (status / query
# / find_affected_areas) we can serve thousands of QPS.
# Caching one connection per thread drops the per-call
# overhead to ~0.01ms and lets the FTS5 query cache stay
# warm across calls.
_TLS = threading.local()


class _Store:
    """A thread-safe, low-overhead SQLite wrapper.

    Reads reuse a thread-local cached connection (each thread
    keeps one open connection, opened on first use). Writes
    (insert / delete / bulk) get their own short-lived
    connection so a writer doesn't block readers in WAL mode.
    """

    def __init__(self, db_path: str) -> None:
        self._db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        """Open a fresh connection (for writes — no caching)."""
        conn = sqlite3.connect(self._db_path, timeout=10.0)
        conn.execute("PRAGMA journal_mode=WAL;")
        conn.execute("PRAGMA synchronous=NORMAL;")
        return conn

    def _read_conn(self) -> sqlite3.Connection:
        """Return the thread-local read connection, opening one
        on first use.
        """
        conn = getattr(_TLS, "conn", None)
        if conn is None:
            conn = self._connect()
            conn.execute("PRAGMA cache_size=-32768;")  # 32 MiB
            conn.execute("PRAGMA temp_store=MEMORY;")
            _TLS.conn = conn
        return conn

    def _ensure_schema(self) -> None:
        with self._init_lock:
            if self._initialized:
                return
            try:
                conn = self._connect()
                try:
                    conn.executescript(_SCHEMA)
                    conn.commit()
                    self._initialized = True
                finally:
                    conn.close()
            except Exception as exc:
                logger.debug("SymbolGraph store init failed: %s", exc)

    def upsert_repo(self, repo: str, branch: str, sha: str,
                    file_count: int, symbol_count: int) -> None:
        self._ensure_schema()
        try:
            conn = self._connect()
            try:
                conn.execute(
                    """
                    INSERT INTO repos(repo, branch, head_sha, last_indexed_at,
                                     file_count, symbol_count)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(repo, branch) DO UPDATE SET
                        head_sha = excluded.head_sha,
                        last_indexed_at = excluded.last_indexed_at,
                        file_count = excluded.file_count,
                        symbol_count = excluded.symbol_count
                    """,
                    (repo, branch, sha, _now_iso(), file_count, symbol_count),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph upsert_repo: %s", exc)

    def clear_repo_files(self, repo: str, branch: str, paths: Iterable[str]) -> None:
        self._ensure_schema()
        paths = list(paths)
        if not paths:
            return
        try:
            conn = self._connect()
            try:
                qmarks = ",".join("?" * len(paths))
                conn.execute(
                    f"DELETE FROM symbols WHERE repo=? AND branch=? AND path IN ({qmarks})",
                    (repo, branch, *paths),
                )
                conn.execute(
                    f"DELETE FROM ref_index WHERE repo=? AND branch=? AND path IN ({qmarks})",
                    (repo, branch, *paths),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph clear_repo_files: %s", exc)

    def insert_symbols(self, repo: str, branch: str,
                        symbols: list[SymbolRecord],
                        refs: list[ReferenceRecord]) -> None:
        self._ensure_schema()
        if not symbols and not refs:
            return
        try:
            conn = self._connect()
            try:
                if symbols:
                    conn.executemany(
                        """INSERT INTO symbols
                           (repo, branch, path, kind, name, line, end_line,
                            parent, signature, docstring)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        [
                            (repo, branch, s.path, s.kind, s.name, s.line,
                             s.end_line, s.parent, s.signature, s.docstring)
                            for s in symbols
                        ],
                    )
                if refs:
                    conn.executemany(
                        """INSERT INTO ref_index
                           (repo, branch, path, name, line, col)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        [
                            (repo, branch, r.path, r.name, r.line, r.col)
                            for r in refs
                        ],
                    )
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph insert_symbols: %s", exc)

    def insert_all(self, repo: str, branch: str,
                   symbols: list[SymbolRecord],
                   refs: list[ReferenceRecord]) -> None:
        """Bulk insert symbols + refs in a single transaction.

        The per-file ``insert_symbols`` was 39% of cold-index
        time because it opened / closed a fresh SQLite
        connection for every file. ``insert_all`` opens one
        connection, runs both INSERTs as ``executemany``,
        and commits once.
        """
        self._ensure_schema()
        if not symbols and not refs:
            return
        try:
            conn = self._connect()
            try:
                # Bump the cache size for the bulk write.
                conn.execute("PRAGMA cache_size=-65536;")  # 64 MiB
                conn.execute("PRAGMA temp_store=MEMORY;")
                conn.execute("BEGIN")
                if symbols:
                    conn.executemany(
                        """INSERT INTO symbols
                           (repo, branch, path, kind, name, line, end_line,
                            parent, signature, docstring)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (
                            (repo, branch, s.path, s.kind, s.name, s.line,
                             s.end_line, s.parent, s.signature, s.docstring)
                            for s in symbols
                        ),
                    )
                if refs:
                    conn.executemany(
                        """INSERT INTO ref_index
                           (repo, branch, path, name, line, col)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (
                            (repo, branch, r.path, r.name, r.line, r.col)
                            for r in refs
                        ),
                    )
                # Mirror symbols into the FTS5 table so
                # ``search_symbols`` can use a MATCH query. We
                # ignore failures (FTS5 may be missing on this
                # host's SQLite build) — the LIKE fallback
                # handles the same query.
                if symbols:
                    try:
                        conn.executemany(
                            """INSERT INTO symbols_fts
                               (repo, branch, path, kind, name, signature,
                                docstring, parent)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                            (
                                (repo, branch, s.path, s.kind, s.name,
                                 s.signature, s.docstring, s.parent)
                                for s in symbols
                            ),
                        )
                    except Exception:
                        pass
                conn.execute("COMMIT")
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph insert_all: %s", exc)

    def get_status(self, repo: str, branch: str) -> IndexStatus | None:
        self._ensure_schema()
        try:
            conn = self._read_conn()
            row = conn.execute(
                "SELECT head_sha, last_indexed_at, file_count, symbol_count "
                "FROM repos WHERE repo=? AND branch=?",
                (repo, branch),
            ).fetchone()
            if row is None:
                return IndexStatus(indexed=False, status="never_indexed")
            return IndexStatus(
                indexed=True,
                latest_sha=row[0] or "",
                last_indexed_at=row[1] or "",
                status="indexed",
                file_count=int(row[2] or 0),
                symbol_count=int(row[3] or 0),
            )
        except Exception as exc:
            logger.debug("SymbolGraph get_status: %s", exc)
            return None

    def search_symbols(self, repo: str, branch: str,
                       query: str, *, limit: int = 50) -> list[SymbolRecord]:
        """Return symbols matching ``query``.

        Uses the FTS5 index when available (fast — single
        full-table-scan becomes a tiny ``MATCH`` lookup),
        with a LIKE-based fallback for hosts whose SQLite
        build doesn't ship FTS5.

        Tokens under 4 chars and stopwords are filtered so
        ``query`` doesn't match on common noise like ``src``,
        ``line``, or ``file``.
        """
        self._ensure_schema()
        tokens = _tokenize(query)
        if not tokens:
            return []
        fts_expr = " ".join(f"{tok}*" for tok in tokens[:8])  # prefix match
        try:
            conn = self._read_conn()
            # Try FTS5 first. The FTS table mirrors all the
            # searchable fields (name / signature / docstring /
            # parent) plus the unindexed row identifiers (path /
            # kind / repo / branch), so we don't need a JOIN
            # to ``symbols`` — that JOIN was 500x slower because
            # SQLite has to re-derive the rowid mapping.
            rows: list[Any]
            try:
                rows = conn.execute(
                    """SELECT path, kind, name, line, end_line,
                              parent, signature, docstring
                       FROM symbols_fts
                       WHERE repo = ? AND branch = ?
                         AND symbols_fts MATCH ?
                       LIMIT ?""",
                    (repo, branch, fts_expr, int(limit)),
                ).fetchall()
            except sqlite3.OperationalError:
                # FTS5 unavailable on this SQLite build — fall
                # back to LIKE.
                conds = []
                params: list[Any] = [repo, branch]
                for tok in tokens[:8]:
                    pat = f"%{tok}%"
                    conds.append(
                        "(name LIKE ? OR signature LIKE ? OR docstring LIKE ? OR path LIKE ?)"
                    )
                    params.extend([pat, pat, pat, pat])
                sql = (
                    "SELECT path, kind, name, line, end_line, parent, signature, docstring "
                    f"FROM symbols WHERE repo=? AND branch=? AND ({' OR '.join(conds)}) "
                    "LIMIT ?"
                )
                params.append(int(limit))
                rows = conn.execute(sql, params).fetchall()
        except Exception as exc:
            logger.debug("SymbolGraph search_symbols: %s", exc)
            return []
        out: list[SymbolRecord] = []
        for r in rows:
            out.append(SymbolRecord(
                repo=repo, branch=branch, path=r[0], kind=r[1], name=r[2],
                line=r[3], end_line=r[4], parent=r[5], signature=r[6],
                docstring=r[7],
            ))
        return out

    def find_affected_areas_from_refs(
        self, repo: str, branch: str, names: Iterable[str], *,
        limit: int = 25,
    ) -> list[AffectedArea]:
        """Return ranked (path, symbol, confidence) for ``names``.

        The confidence is ``min(1.0, ref_count / 10)`` — the more
        a file references the suspect names, the higher the
        confidence.
        """
        self._ensure_schema()
        names = [n for n in names if n]
        if not names:
            return []
        try:
            conn = self._read_conn()
            qmarks = ",".join("?" * len(names))
            rows = conn.execute(
                f"""
                SELECT path, name, COUNT(*) AS n
                FROM ref_index
                WHERE repo=? AND branch=? AND name IN ({qmarks})
                GROUP BY path
                ORDER BY n DESC
                LIMIT ?
                """,
                (repo, branch, *names, int(limit)),
            ).fetchall()
        except Exception as exc:
            logger.debug("SymbolGraph find_affected_areas_from_refs: %s", exc)
            return []
        out: list[AffectedArea] = []
        for path, name, n in rows:
            conf = min(0.95, max(0.2, float(n) / 10.0))
            out.append(AffectedArea(
                path=path,
                symbol=name,
                confidence=round(conf, 3),
                reason="symbol_reference",
            ))
        return out


def _now_iso() -> str:
    import datetime as _dt
    return _dt.datetime.now(_dt.UTC).isoformat()


_STOPWORDS = frozenset({
    "src", "lib", "var", "let", "const", "function", "class",
    "return", "import", "from", "self", "this", "true", "false",
    "none", "null", "type", "value", "data",
    "test", "main", "init", "call", "get", "set", "new", "old",
    "err", "msg", "obj", "ctx", "req", "res", "arg", "args",
    "key", "val", "env", "run", "log", "tmp",
    "the", "and", "for", "with", "that", "line", "file", "path", "name", "error",
})


def _tokenize(text: str) -> list[str]:
    """Extract candidate identifier tokens from ``text``.

    Filters out very short tokens (<4 chars), Python/JS keywords,
    and common English stopwords. The point is to surface
    *project-specific* symbol names, not generic syntax tokens.
    """
    if not text:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for tok in re.findall(r"[A-Za-z_][\w]{3,}", text):
        if tok.lower() in seen:
            continue
        if tok.lower() in _STOPWORDS:
            continue
        seen.add(tok.lower())
        out.append(tok)
    return out


# ── SymbolGraph client ──────────────────────────────────────────────


class SymbolGraph:
    """The default :class:`RepoGraphClient` implementation.

    Builds and persists a real code-symbol index. Default
    backend — selected by :func:`get_default_repo_graph`
    when no hosted API key is set.
    """

    name: str = "symbol"

    def __init__(
        self,
        root: str | os.PathLike[str] | None = None,
        *,
        db_path: str | None = None,
    ) -> None:
        env_root = os.getenv("EDEN_LOCAL_REPO_PATH", "").strip()
        if root is None:
            root = env_root or os.getcwd()
        self._root = Path(root).resolve()
        self._store = _Store(db_path or SYMBOL_GRAPH_DB)
        self._index_lock = threading.Lock()
        # Track in-flight indexing so concurrent request_index
        # calls don't all start a full re-walk.
        self._indexing = False

    # ── Public API ───────────────────────────────────────────────

    async def status(
        self, repo_full_name: str, branch: str = "main",
    ) -> dict[str, Any] | None:
        try:
            st = self._store.get_status(repo_full_name, branch)
            if st is None:
                return None
            sha = _git_head_sha(self._root)
            return {
                "indexed": bool(st.indexed),
                "latest_sha": sha or st.latest_sha,
                "last_indexed_at": st.last_indexed_at,
                "status": st.status,
                "file_count": st.file_count,
                "symbol_count": st.symbol_count,
                "raw": {"provider": "symbol"},
            }
        except Exception as exc:
            logger.debug("SymbolGraph.status: %s", exc)
            return None

    async def request_index(
        self,
        repo_full_name: str,
        branch: str = "main",
        *,
        background: bool = True,
    ) -> bool:
        """Build / refresh the in-process index.

        When ``background=True`` (default) the indexing runs
        on a daemon thread and returns immediately. When
        ``background=False`` we block until done (used by
        tests).
        """
        if background:
            t = threading.Thread(
                target=self._safe_index,
                args=(repo_full_name, branch),
                daemon=True,
            )
            t.start()
            return True
        return self._safe_index(repo_full_name, branch)

    async def query(
        self, repo_full_name: str, question: str,
        branch: str = "main",
    ) -> GraphQueryResult | None:
        try:
            # Make sure we have at least some kind of index
            # before we answer — if the user never called
            # request_index, do a synchronous one now (it's
            # cheap and bounded by SYMBOL_GRAPH_MAX_FILES).
            st = self._store.get_status(repo_full_name, branch)
            if st is None or not st.indexed:
                self._safe_index(repo_full_name, branch)
            symbols = self._store.search_symbols(
                repo_full_name, branch, question, limit=25,
            )
            files = sorted({s.path for s in symbols})
            snippets: list[tuple[str, str, str]] = []
            for s in symbols:
                excerpt = s.signature or s.docstring or s.kind
                snippets.append((s.path, f"{s.line}-{s.end_line}", excerpt))
            return GraphQueryResult(
                answer="",
                snippets=snippets,
                files=files,
                raw={
                    "provider": "symbol",
                    "matched": len(symbols),
                    "names": [s.name for s in symbols[:8]],
                },
            )
        except Exception as exc:
            logger.debug("SymbolGraph.query: %s", exc)
            return None

    async def find_affected_areas(
        self,
        repo_full_name: str,
        *,
        error_signature: str = "",
        trace_ids: tuple[str, ...] = (),
        file_path_hint: str = "",
        branch: str = "main",
    ) -> list[AffectedArea]:
        try:
            st = self._store.get_status(repo_full_name, branch)
            if st is None or not st.indexed:
                self._safe_index(repo_full_name, branch)
            out: list[AffectedArea] = []
            seen: set[str] = set()

            # 1) file_path_hint is the strongest signal — pre-seed the
            #    confidence so it always sorts above reference noise.
            if file_path_hint and file_path_hint not in seen:
                out.append(AffectedArea(
                    path=file_path_hint,
                    symbol="",
                    confidence=0.99,
                    reason="file_path_hint",
                ))
                seen.add(file_path_hint)

            # 2) Error signature tokens → reference search.
            tokens = _tokenize(error_signature or "")
            if tokens:
                ranked = self._store.find_affected_areas_from_refs(
                    repo_full_name, branch, tokens, limit=25,
                )
                for area in ranked:
                    if area.path in seen:
                        continue
                    seen.add(area.path)
                    out.append(area)

            # 3) Stack-trace regex (Python tracebacks).
            if error_signature:
                for m in re.finditer(
                    r'File\s+"([^"]+)",\s*line\s+\d+,\s*in\s+(\w+)',
                    error_signature,
                ):
                    path = m.group(1)
                    sym = m.group(2)
                    if not path or path in seen:
                        continue
                    seen.add(path)
                    out.append(AffectedArea(
                        path=path,
                        symbol=sym,
                        confidence=0.7,
                        reason="stack_trace_match",
                    ))

            # 4) Fall back to symbol search if nothing else matched.
            if not out:
                hits = self._store.search_symbols(
                    repo_full_name, branch, error_signature or "",
                    limit=10,
                )
                for s in hits:
                    if s.path in seen:
                        continue
                    seen.add(s.path)
                    out.append(AffectedArea(
                        path=s.path,
                        symbol=s.name,
                        confidence=0.4,
                        reason="symbol_name_match",
                    ))

            out.sort(key=lambda a: a.confidence, reverse=True)
            return out
        except Exception as exc:
            logger.debug("SymbolGraph.find_affected_areas: %s", exc)
            return []

    # ── Internals ────────────────────────────────────────────────

    def _safe_index(self, repo_full_name: str, branch: str) -> bool:
        """Synchronous (re-)index. Returns True on success."""
        if self._indexing:
            # Another thread is already indexing — wait briefly
            # so we don't double-walk. We poll up to 30s.
            for _ in range(60):
                time.sleep(0.5)
                if not self._indexing:
                    break
        with self._index_lock:
            self._indexing = True
            try:
                return self._index_locked(repo_full_name, branch)
            finally:
                self._indexing = False

    def _index_locked(self, repo_full_name: str, branch: str) -> bool:
        try:
            sha = _git_head_sha(self._root)
            prev = self._store.get_status(repo_full_name, branch)

            # Decide which files to (re-)parse.
            if prev is not None and prev.latest_sha and prev.latest_sha == sha:
                # Same SHA → no-op unless we have no symbols (cold).
                if prev.symbol_count > 0:
                    return True
                changed_paths = None
            else:
                changed_paths = _git_changed_paths(self._root, prev.latest_sha if prev else "")

            files: list[Path]
            if changed_paths is None:
                files = list(_iter_files(self._root))
            else:
                files = []
                for rel in changed_paths:
                    p = self._root / rel
                    if (
                        p.exists()
                        and p.is_file()
                        and (p.suffix.lower() == _PY_EXT or p.suffix.lower() in _TEXT_EXTS)
                        and p.stat().st_size <= SYMBOL_GRAPH_MAX_FILE_BYTES
                    ):
                        files.append(p)
                # Always also re-index any new files not in the
                # diff (e.g. files added in the last commit but
                # not present in `git diff` for some reason).
                # Cheap because the index is a flat walk.
                if not files:
                    files = list(_iter_files(self._root))

            if not files:
                self._store.upsert_repo(
                    repo_full_name, branch, sha, 0, 0,
                )
                return True

            # Wipe symbols for the changed files before re-inserting.
            rel_paths = [str(f.relative_to(self._root)) for f in files]
            self._store.clear_repo_files(
                repo_full_name, branch, rel_paths,
            )

            # ── Parse all files in parallel ─────────────────────────
            # AST parsing is CPU-bound but releases the GIL during
            # ``compile()`` so ThreadPoolExecutor works well.
            # Each worker returns ``(rel_path, symbols, refs)``.
            parsed = _parse_files_parallel(
                files, self._root, max_workers=_INDEX_WORKERS,
            )

            # ── Single bulk insert into SQLite ─────────────────────
            # Accumulate everything into one executemany() per
            # table inside a single transaction. The previous
            # per-file INSERT was 39% of cold-index time.
            all_symbols: list[SymbolRecord] = []
            all_refs: list[ReferenceRecord] = []
            for rel, symbols, refs in parsed:
                for sym in symbols:
                    sym.repo = repo_full_name
                    sym.branch = branch
                for ref in refs:
                    ref.repo = repo_full_name
                    ref.branch = branch
                all_symbols.extend(symbols)
                all_refs.extend(refs)
                if len(all_symbols) >= SYMBOL_GRAPH_MAX_SYMBOLS:
                    break

            self._store.insert_all(
                repo_full_name, branch, all_symbols, all_refs,
            )

            self._store.upsert_repo(
                repo_full_name, branch, sha, len(parsed),
                len(all_symbols),
            )
            return True
        except Exception as exc:
            logger.debug("SymbolGraph index failed: %s", exc)
            return False
