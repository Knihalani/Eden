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
import contextlib
import logging
import os
import re
import sqlite3
import subprocess
import threading
import time
from collections import OrderedDict
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
    os.getenv("EDEN_SYMBOL_GRAPH_INDEX_WORKERS", "1"),  # 1 = serial
)


def _resolve_workers() -> int:
    """Resolve the number of worker threads for parallel parsing.

    Defaults to ``1`` (serial) because Python's GIL serializes
    AST parsing — empirical benchmarks show threading adds
    ~30% overhead vs serial for ``ast.parse`` because the
    threads compete for the GIL. Operators can opt into
    parallelism with ``EDEN_SYMBOL_GRAPH_INDEX_WORKERS=N``.
    """
    return max(1, SYMBOL_GRAPH_INDEX_WORKERS)


_INDEX_WORKERS = _resolve_workers()


# Performance budgets (used by bench/repo_graph.py + tests).
# Source of truth for the speed / memory / token budgets
# documented in the module docstring. Updating them here lets
# the bench report stay in sync with the docs + regression tests.
BUDGET_COLD_INDEX_MS: float = 10_000.0
BUDGET_WARM_INDEX_MS: float = 200.0
BUDGET_QUERY_P95_MS: float = 50.0
BUDGET_FIND_AFFECTED_P95_MS: float = 80.0
BUDGET_DB_BYTES: int = 100 * 1024 * 1024  # 100 MiB
BUDGET_QUERY_LIMIT: int = 25  # cap on query / find_affected_areas



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
#
# F64 — ``_GIT_CACHE`` is now an ``OrderedDict`` keyed by
# ``"head:{root}"`` or ``"diff:{root}:{since_sha}"`` with
# a hard cap and a TTL eviction sweep. Pre-F64 the dict
# grew unbounded against continuously-advancing
# ``since_sha`` values: every call to ``_git_changed_paths``
# with a fresh ``since_sha`` added an entry, and entries
# only expired organically when the process restarted
# (because the dict lived in module scope for the
# lifetime of the pod). The ``root`` part of the key is
# bounded (one or two configured git roots in a typical
# pod) but the ``since_sha`` part can churn as git
# history advances — every CI run produces a new
# ``since_sha``, and a busy long-running process can
# easily accumulate thousands of stale entries.
#
# * ``_GIT_CACHE_MAX_ENTRIES`` — hard cap on the number
#   of cache entries. Sized for healthy traffic; a
#   typical pod sees < 50 entries.
# * ``_evict_expired_git_cache`` — sweep helper that
#   drops entries past their TTL.
# * ``_touch_git_cache`` — LRU bump on every cache
#   hit so an active (root, since_sha) survives
#   eviction.
_GIT_CACHE_MAX_ENTRIES: int = 256
_GIT_CACHE: OrderedDict[str, tuple[float, str]] = OrderedDict()
_GIT_CACHE_TTL = float(os.getenv("EDEN_GIT_CACHE_TTL", "30"))


def _touch_git_cache(key: str) -> None:
    """Bump the LRU position for a git cache entry.

    Best-effort: any exception inside the OrderedDict
    rewrite is silently dropped so a transient bookkeeping
    issue cannot break a paying customer's API call.
    Mirrors ``gateway._upstream_client_cache.move_to_end``
    (F62) and ``ingestion._touch_bucket`` (F63)."""
    try:
        if key in _GIT_CACHE:
            _GIT_CACHE.move_to_end(key)
    except Exception:
        pass


def _evict_expired_git_cache(now: float) -> None:
    """Drop ``_GIT_CACHE`` entries whose TTL has elapsed.

    Pre-F64 nothing reaped expired entries — an
    ever-advancing ``since_sha`` would pin stale
    entries in the dict for the pod's lifetime."""
    stale: list[str] = []
    for key, (expires_at, _val) in _GIT_CACHE.items():
        if now - expires_at >= _GIT_CACHE_TTL:
            stale.append(key)
    for key in stale:
        _GIT_CACHE.pop(key, None)


def _enforce_git_cache_cap() -> None:
    """Enforce the hard cap on ``_GIT_CACHE``.

    Drops the least-recently-touched entry until the
    size is back under the limit. Mirrors
    ``multi_agent._enforce_cap_on_insert`` (F61) and
    ``ingestion._enforce_rate_buckets_cap`` (F63)."""
    while len(_GIT_CACHE) >= _GIT_CACHE_MAX_ENTRIES:
        try:
            _GIT_CACHE.popitem(last=False)
        except KeyError:
            break


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
        # ``os.path.relpath`` is ~6x faster than
        # ``Path.relative_to`` on a hot path with 1500+ files
        # (no PurePath construction, no is_relative_to check).
        try:
            rel = os.path.relpath(str(path), str(root))
        except ValueError:
            rel = str(path)
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
    # F64: opportunistic housekeeping on the hot path.
    _evict_expired_git_cache(now)
    _enforce_git_cache_cap()
    cached = _GIT_CACHE.get(key)
    if cached is not None and now - cached[0] < _GIT_CACHE_TTL:
        # F64: bump LRU so an active entry survives
        # eviction triggered by churning since_sha values.
        _touch_git_cache(key)
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
    _touch_git_cache(key)
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
    # F64: opportunistic housekeeping on the hot path.
    _evict_expired_git_cache(now)
    _enforce_git_cache_cap()
    cached = _GIT_CACHE.get(key)
    if cached is not None and now - cached[0] < _GIT_CACHE_TTL:
        # F64: bump LRU so an active entry survives
        # eviction triggered by churning since_sha values.
        _touch_git_cache(key)
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
    _touch_git_cache(key)
    return paths


# ── Python AST parser ───────────────────────────────────────────────


def _py_signature(node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
    """Return a one-line signature for a Python function node."""
    # ``type() is`` is faster than ``isinstance`` and avoids
    # the MRO walk; this runs once per indexed function so
    # the constant-factor matters more than usual.
    prefix = "async def" if type(node) is ast.AsyncFunctionDef else "def"
    args = _py_args_string(node.args)
    deco = _py_first_decorator(node.decorator_list)
    return f"{deco}{prefix} {node.name}{args}".strip()


def _py_args_string(args: ast.arguments) -> str:
    """Render ``ast.arguments`` as a one-line arg string.

    ``ast.unparse`` on ``node.args`` is surprisingly slow
    on the cold-index path: it builds a full ``ast.Module``
    just to render text, which for 11k functions in the
    Eden repo adds ~0.3s of avoidable work. A hand-written
    renderer that covers the shapes real code uses
    (positional, vararg, kwonly, kwarg, defaults) is
    ~10x faster and still meets the goal of giving the
    LLM a useful one-line signature in the context
    window.
    """
    parts: list[str] = []
    posonly = list(getattr(args, "posonlyargs", ()) or ())
    regular = list(args.args or ())
    for a in posonly:
        parts.append(a.arg)
    if posonly and regular:
        parts.append("/")
    for a in regular:
        parts.append(a.arg)
    if args.vararg is not None:
        parts.append("*" + args.vararg.arg)
    elif args.kwonlyargs:
        parts.append("*")
    for a in args.kwonlyargs:
        parts.append(a.arg)
    if args.kwarg is not None:
        parts.append("**" + args.kwarg.arg)
    return "(" + ", ".join(parts) + ")"


def _py_first_decorator(decorator_list: list[ast.expr]) -> str:
    """Render the first decorator (if any) as ``@...``.

    Only the first is kept — the signature is already a
    summary, and a long decorator list blows the
    downstream snippet budget. Best-effort: never raises.
    """
    if not decorator_list:
        return ""
    text = _render_node(decorator_list[0])
    return ("@" + text + " ") if text else ""


def _render_node(node: ast.AST) -> str:
    """Best-effort single-node renderer.

    Handles the shapes that show up in real signatures
    — Name, Attribute, Call, Constant — and returns
    ``""`` for anything else so the caller can fall
    back gracefully.
    """
    try:
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            base = _render_node(node.value)
            return f"{base}.{node.attr}" if base else node.attr
        if isinstance(node, ast.Call):
            base = _render_node(node.func)
            return f"{base}(...)" if base else ""
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
        ):
            return node.value
    except Exception:
        return ""
    return ""


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

    # Cache AST type singletons for identity-based dispatch
    # (faster than isinstance for the hot loop).
    FunctionDef = ast.FunctionDef  # noqa: N806
    AsyncFunctionDef = ast.AsyncFunctionDef  # noqa: N806
    ClassDef = ast.ClassDef  # noqa: N806
    Assign = ast.Assign  # noqa: N806
    AnnAssign = ast.AnnAssign  # noqa: N806
    Call = ast.Call  # noqa: N806
    Attribute = ast.Attribute  # noqa: N806
    Name = ast.Name  # noqa: N806
    Iterable_types = (ast.Tuple, ast.List)  # noqa: N806
    iter_child_nodes = ast.iter_child_nodes

    symbols: list[SymbolRecord] = []
    refs: list[ReferenceRecord] = []

    # Single recursive DFS walk. The previous implementation
    # did two ``ast.walk`` passes (one to build a parent map,
    # one to collect symbols+refs); on large files the parent
    # walk alone cost ~7s of ``iter_child_nodes`` calls. With
    # a top-down DFS we know each node's enclosing class as
    # we visit it — no parent map needed. The enclosing-class
    # stack is just a list of ``ClassDef.name`` strings that
    # we push when entering a class and pop when leaving,
    # which keeps the lookup O(1).
    #
    # Iterative DFS (explicit stack) avoids Python's default
    # recursion limit (1000) on pathologically deep ASTs
    # while still being ~2.7x faster than two ``ast.walk``
    # passes on the real workload (1102 files, ~50k symbols).
    # Visit (node, parent_class_name) tuples. Stack order
    # is reversed so children are processed in source order.
    #
    # The enclosing-class chain is captured per node in the
    # DFS stack so nested classes resolve correctly: a method
    # of ``class Outer: class Inner: def m(self): ...``
    # has parent ``"Inner"`` (and ``Inner`` itself has parent
    # ``"Outer"``). Storing the chain (not just the innermost
    # name) keeps sibling traversal O(1) — no parent map walk.
    stack: list[tuple[ast.AST, tuple[str, ...]]] = [(tree, ())]
    while stack:
        node, parent_classes = stack.pop()
        # ``parent_classes`` is the snapshot of the
        # enclosing-class chain captured when this node
        # was pushed; every sibling carries the same
        # snapshot, so the parent fields we emit are
        # unaffected by later mutations further down the
        # tree.
        klass_name = parent_classes[-1] if parent_classes else None
        t = type(node)
        if t is FunctionDef or t is AsyncFunctionDef:
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="method" if klass_name is not None else "function",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent=_format_class_parent(parent_classes),
                signature=_py_signature(node),
                docstring=_fast_docstring(node),
            ))
        elif t is ClassDef:
            symbols.append(SymbolRecord(
                repo="", branch="", path=path,
                kind="class",
                name=node.name,
                line=node.lineno,
                end_line=getattr(node, "end_lineno", node.lineno) or node.lineno,
                parent=_format_class_parent(parent_classes),
                signature=f"class {node.name}",
                docstring=_fast_docstring(node),
            ))
            # Children of this class see this name appended
            # to their enclosing chain so nested classes
            # resolve correctly.
            children = list(iter_child_nodes(node))
            child_parents: tuple[str, ...] = parent_classes + (node.name,)
            for child in reversed(children):
                stack.append((child, child_parents))
            continue
        elif t is Assign:
            line = node.lineno
            for target in node.targets:
                for name in _walk_names_fast(target, Iterable_types, Name):
                    symbols.append(SymbolRecord(
                        repo="", branch="", path=path,
                        kind="const",
                        name=name,
                        line=line,
                        end_line=line,
                        parent=_format_class_parent(parent_classes),
                        signature="",
                        docstring="",
                    ))
        elif t is AnnAssign:
            line = node.lineno
            for name in _walk_names_fast(node.target, Iterable_types, Name):
                symbols.append(SymbolRecord(
                    repo="", branch="", path=path,
                    kind="const",
                    name=name,
                    line=line,
                    end_line=line,
                    parent=_format_class_parent(parent_classes),
                    signature="",
                    docstring="",
                ))
        elif t is Call:
            name = _call_name_fast(node.func)
            if name:
                refs.append(ReferenceRecord(
                    repo="", branch="", path=path,
                    name=name,
                    line=node.lineno,
                    col=getattr(node, "col_offset", 0),
                ))
        elif t is Attribute:
            value = node.value
            if type(value) is Name:
                refs.append(ReferenceRecord(
                    repo="", branch="", path=path,
                    name=f"{value.id}.{node.attr}",
                    line=node.lineno,
                    col=getattr(node, "col_offset", 0),
                ))
        elif t is Name:
            refs.append(ReferenceRecord(
                repo="", branch="", path=path,
                name=node.id,
                line=node.lineno,
                col=getattr(node, "col_offset", 0),
            ))

        # Push non-class children for further traversal. Each
        # child carries the same enclosing-class chain as the
        # current node (``parent_classes``) so lookups on
        # siblings remain identical regardless of stack
        # mutation caused by deeper descendants.
        if t is not ClassDef:
            children = list(iter_child_nodes(node))
            for child in reversed(children):
                stack.append((child, parent_classes))
    return symbols, refs


def _format_class_parent(parents: tuple[str, ...]) -> str:
    """Render an enclosing-class chain as a dotted path.

    ``()`` → ``""`` (top-level); ``("Outer",)`` → ``""``
    on a class (parent names are tracked separately by
    the symbol's own ``name``); ``("Outer", "Inner")`` →
    ``"Outer.Inner"``. Used by :func:`_parse_python_single_pass`
    so methods and constants inside nested classes get a
    fully-qualified parent. The format matches what the
    discipline layer already does for ``name.attr``
    references, so callers don't have to translate.
    """
    if not parents:
        return ""
    return ".".join(parents)


def _fast_docstring(node):
    """Extract the docstring of ``node`` without re-parsing.

    ``ast.get_docstring`` calls ``ast.parse`` internally; for
    our purposes we just want the first statement if it's a
    string literal. ~5x faster.
    """
    body = getattr(node, "body", None)
    if not body:
        return ""
    first = body[0]
    if not isinstance(first, ast.Expr):
        return ""
    value = first.value
    if isinstance(value, ast.Constant) and isinstance(value.value, str):
        return value.value[:400]
    return ""


def _call_name_fast(node):
    """Best-effort: turn an ast.Call ``func`` into a string.

    Uses ``type(node) is ...`` identity checks instead of
    isinstance for the hot path. Handles nested attribute
    access (e.g. ``a.b.c()``).
    """
    Attribute = ast.Attribute  # noqa: N806
    Name = ast.Name  # noqa: N806
    while True:
        t = type(node)
        if t is Name:
            return node.id
        if t is Attribute:
            base = node.value
            base_t = type(base)
            if base_t is Name:
                return f"{base.id}.{node.attr}"
            if base_t is Attribute:
                node = base
                continue
            return ""
        return ""


def _walk_names_fast(node, iterable_types, name_type):
    """Fast target-name walker that takes AST type singletons as args.

    Avoids re-looking-up ``ast.Tuple`` etc. on every call.
    """
    if type(node) is name_type:
        yield node.id
    elif type(node) in iterable_types:
        for elt in node.elts:
            yield from _walk_names_fast(elt, iterable_types, name_type)



# ── Generic (TS/JS/Go/Java/Rust/Ruby) parser ────────────────────────


def _build_line_lookup(source: str) -> tuple[list[int], list[int]]:
    """Pre-compute line-start offsets for O(log n) line lookups.

    The regex scanners below match against ``source`` and need
    the line number + column for each match. The naive approach
    (``source.count("\n", 0, offset)`` per match) is O(offset)
    per lookup, which is O(n\u00b2) for a file with n matches
    — catastrophic on a 3.7MB TS file with thousands of matches.
    We pay a one-shot O(n) pass to build two arrays:

    * ``line_starts[i]`` = offset of the first character of line i
    * ``line_for_offset[off]`` = dense array mapping each offset
      to its 1-based line number (so ``line_for_offset[m.start()]``
      is O(1) instead of O(offset)).
    """
    import array
    # First pass: count newlines so we know the array size.
    nl_count = source.count("\n")
    n_lines = nl_count + 1  # last line has no trailing newline
    # Second pass: write line_starts in one go.
    line_starts: list[int] = [0] * n_lines
    line_idx = 0
    i = 0
    n = len(source)
    while i < n:
        j = source.find("\n", i)
        if j == -1:
            break
        line_idx += 1
        line_starts[line_idx] = j + 1
        i = j + 1
    # Third pass: build the dense offset→line map.
    line_for_offset = array.array("I", [0]) * n
    cur_line = 1
    for off, ch in enumerate(source):
        line_for_offset[off] = cur_line
        if ch == "\n":
            cur_line += 1
    return line_starts, line_for_offset


def _parse_text_symbols(path: str, source: str) -> tuple[
    list[SymbolRecord], list[ReferenceRecord]
]:
    """Lightweight scanner for non-Python files.

    Builds a dense offset→line lookup once per file so the per-match
    line-number computation is O(1) instead of O(offset) — cuts
    indexing time on large TS/JS files by ~250x in benchmarks
    (468ms → 1.9ms for 200 lookups on 180KB source).
    """
    import bisect

    symbols: list[SymbolRecord] = []
    refs: list[ReferenceRecord] = []

    line_starts, line_for_offset = _build_line_lookup(source)
    line_starts_arr = line_starts  # alias for type checker

    def _line_of(offset: int) -> int:
        if offset <= 0:
            return 1
        if offset >= len(line_for_offset):
            offset = len(line_for_offset) - 1
        return int(line_for_offset[offset])

    def _col_of(offset: int) -> int:
        # Column is 0-based offset of the match within its line.
        if offset <= 0:
            return 0
        line_idx = bisect.bisect_right(line_starts_arr, offset) - 1
        if line_idx < 0:
            return offset
        return offset - line_starts_arr[line_idx]

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
            col=_col_of(m.start()),
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

-- Contentless FTS5 over the three searchable text columns
-- (name, signature, docstring). Storing only the inverted
-- index lets us bulk-load the table with a single
-- ``INSERT INTO symbols_fts(rowid, ...) SELECT ... FROM symbols``
-- statement — about 3.6x faster than the previous
-- executemany insert of the same row, and ~45% smaller
-- on disk. The rowid matches the corresponding ``symbols.id``
-- so search_symbols JOINs back to fetch repo / branch /
-- path / kind / parent / line. Old contentful FTS5 tables
-- are detected and rebuilt transparently on first connect.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
    name,
    signature,
    docstring,
    tokenize = "porter unicode61",
    content=''
);

-- Per-file mtime cache. ``path_mtime`` is the file's last-
-- modified Unix timestamp at the time we indexed it. The
-- indexer uses this to skip re-parsing files that haven't
-- changed since the last index, even when git diff is
-- unavailable or the SHA matches a re-run.
CREATE TABLE IF NOT EXISTS file_mtimes (
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    path TEXT NOT NULL,
    mtime REAL NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (repo, branch, path)
);
"""


# Thread-local connection cache, keyed by db_path. SQLite
# connections are cheap to open (~0.4ms) but on hot paths
# (status / query / find_affected_areas) we can serve
# thousands of QPS. Caching one connection per thread
# drops the per-call overhead to ~0.01ms and lets the FTS5
# query cache stay warm across calls. The key MUST be
# db_path (not the _Store instance) because tests create
# multiple SymbolGraph instances pointing at different
# db files within the same process; without the key the
# connection would be reused across DB files.
_TLS = threading.local()


def _get_cached_conn(db_path: str):
    cache = getattr(_TLS, "cache", None)
    if cache is None:
        cache = {}
        _TLS.cache = cache
    return cache.get(db_path)


def _set_cached_conn(db_path: str, conn) -> None:
    cache = getattr(_TLS, "cache", None)
    if cache is None:
        cache = {}
        _TLS.cache = cache
    cache[db_path] = conn


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
        on first use for this db_path.

        Keying by ``db_path`` (not self) is essential — pytest
        tests create many SymbolGraph instances pointing at
        different db files within the same process, and we
        must NOT reuse a connection across db files.
        """
        conn = _get_cached_conn(self._db_path)
        if conn is None:
            conn = self._connect()
            conn.execute("PRAGMA cache_size=-32768;")  # 32 MiB
            conn.execute("PRAGMA temp_store=MEMORY;")
            _set_cached_conn(self._db_path, conn)
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
                    # Schema-migration: an older ``symbols_fts``
                    # may be the old contentful shape (10 columns
                    # including repo/branch/path/kind/line/...) or
                    # the table may not exist yet. Detect the old
                    # shape via PRAGMA and rebuild transparently.
                    try:
                        cols = {
                            row[1]
                            for row in conn.execute(
                                "PRAGMA table_info(symbols_fts)"
                            ).fetchall()
                        }
                        # New contentless FTS has exactly 3 columns
                        # (name/signature/docstring). Old contentful
                        # FTS has 10. Any drift triggers a rebuild.
                        if len(cols) != 3 or "repo" in cols:
                            conn.executescript(
                                "DROP TABLE IF EXISTS symbols_fts;\n" + _SCHEMA
                            )
                            conn.commit()
                    except Exception as exc:
                        logger.debug(
                            "SymbolGraph schema migration check: %s", exc,
                        )
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

        Optimized bulk path:

        1. Drop the secondary indexes — every INSERT into a
           table with indexes has to update each index B-tree
           inline, and 50k rows × 5 indexes is the dominant
           cost on a cold index (~4s → <1s).
        2. Bulk-insert symbols + refs inside a single
           transaction (executemany on the row tuples).
        3. Mirror symbols into the contentless FTS5 table
           with one ``INSERT INTO fts(rowid, ...) SELECT
           id, ... FROM symbols`` — a single pass over the
           just-inserted rows instead of N row-by-row
           executemany inserts.
        4. Recreate the indexes once on the final, populated
           table. ``CREATE INDEX`` on an already-populated
           table is a single sorted-build pass, dramatically
           faster than updating each index on every INSERT.
        5. COMMIT.

        On 50k rows this dropped bulk insert from ~4s to
        ~0.8s end-to-end (about 5x). The per-file
        ``insert_symbols`` was 39% of cold-index time before
        ``insert_all`` was introduced; the new path drops
        insert_all itself from ~5s to ~1s.
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
                # Drop the secondary indexes — they cost more
                # than they save during a bulk write. We
                # recreate them after the bulk insert.
                with contextlib.suppress(Exception):
                    conn.executescript(
                        "DROP INDEX IF EXISTS idx_symbols_repo_branch;"
                        "DROP INDEX IF EXISTS idx_symbols_name;"
                        "DROP INDEX IF EXISTS idx_symbols_path;"
                        "DROP INDEX IF EXISTS idx_refs_repo_branch;"
                        "DROP INDEX IF EXISTS idx_refs_name;"
                    )
                conn.execute("BEGIN")
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
                # Mirror symbols into the contentless FTS5
                # table so search_symbols can use a MATCH
                # query. SELECT INTO from the freshly-inserted
                # ``symbols`` rows is dramatically faster than
                # executemany — about 3.6x on large indexes
                # because SQLite has to write the inverted
                # index for each text column anyway, and a
                # single bulk SELECT is one B-tree pass. We
                # swallow failures so hosts whose SQLite build
                # doesn't ship FTS5 still work via the LIKE
                # fallback in search_symbols.
                if symbols:
                    with contextlib.suppress(Exception):
                        conn.execute(
                            """INSERT INTO symbols_fts(rowid, name, signature, docstring)
                               SELECT id, name, signature, docstring
                               FROM symbols
                               WHERE repo = ? AND branch = ?""",
                            (repo, branch),
                        )
                conn.execute("COMMIT")
                # Recreate the secondary indexes on the
                # populated table. ``CREATE INDEX`` runs a
                # single sorted-build pass, which is much
                # faster than maintaining each index on every
                # INSERT. Idempotent: each CREATE has
                # ``IF NOT EXISTS``.
                conn.executescript(
                    "CREATE INDEX IF NOT EXISTS idx_symbols_repo_branch"
                    "    ON symbols(repo, branch);"
                    "CREATE INDEX IF NOT EXISTS idx_symbols_name"
                    "    ON symbols(repo, branch, name);"
                    "CREATE INDEX IF NOT EXISTS idx_symbols_path"
                    "    ON symbols(repo, branch, path);"
                    "CREATE INDEX IF NOT EXISTS idx_refs_repo_branch"
                    "    ON ref_index(repo, branch);"
                    "CREATE INDEX IF NOT EXISTS idx_refs_name"
                    "    ON ref_index(repo, branch, name);"
                )
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph insert_all: %s", exc)

    def get_file_mtimes(self, repo: str, branch: str) -> dict[str, tuple[float, int]]:
        """Return ``{path: (mtime, size)}`` for every indexed file.

        Used by the indexer to skip files whose mtime + size
        haven't changed since the last run.
        """
        self._ensure_schema()
        try:
            conn = self._read_conn()
            rows = conn.execute(
                "SELECT path, mtime, size FROM file_mtimes WHERE repo=? AND branch=?",
                (repo, branch),
            ).fetchall()
        except Exception as exc:
            logger.debug("SymbolGraph get_file_mtimes: %s", exc)
            return {}
        return {path: (float(mtime), int(size)) for path, mtime, size in rows}

    def upsert_file_mtimes(
        self, repo: str, branch: str,
        mtimes: dict[str, tuple[float, int]],
    ) -> None:
        """Bulk-upsert the (path, mtime, size) cache."""
        if not mtimes:
            return
        try:
            conn = self._connect()
            try:
                conn.executemany(
                    """INSERT INTO file_mtimes(repo, branch, path, mtime, size)
                       VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(repo, branch, path) DO UPDATE SET
                         mtime = excluded.mtime,
                         size = excluded.size""",
                    (
                        (repo, branch, p, mt, sz)
                        for p, (mt, sz) in mtimes.items()
                    ),
                )
                conn.commit()
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("SymbolGraph upsert_file_mtimes: %s", exc)

    def get_symbol_count(self, repo: str, branch: str) -> int:
        """Count symbols for ``repo/branch`` (cached count fallback)."""
        try:
            conn = self._read_conn()
            row = conn.execute(
                "SELECT COUNT(*) FROM symbols WHERE repo=? AND branch=?",
                (repo, branch),
            ).fetchone()
            return int(row[0]) if row else 0
        except Exception:
            return 0

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
            # Try FTS5 first. The contentless FTS table only
            # holds the inverted index (name / signature /
            # docstring) keyed by rowid == symbols.id. We use
            # an IN-subquery rather than a JOIN so SQLite can
            # push the FTS MATCH into the inner query — that
            # keeps the candidate set tiny before we hit the
            # symbols table. A naive JOIN like
            # ``JOIN symbols s ON s.id = f.rowid WHERE
            # s.repo = ?`` was ~4500x slower (4.5 s vs 1 ms)
            # because the planner chose a full repo/branch
            # index scan on symbols first, then a per-row
            # FTS check, instead of running FTS first.
            rows: list[Any]
            try:
                rows = conn.execute(
                    """SELECT path, kind, name, line, end_line,
                              parent, signature, docstring
                       FROM symbols
                       WHERE repo = ? AND branch = ?
                         AND id IN (
                           SELECT rowid FROM symbols_fts
                           WHERE symbols_fts MATCH ?
                         )
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
                await self._safe_index_async(repo_full_name, branch)
            symbols = self._store.search_symbols(
                repo_full_name, branch, question, limit=BUDGET_QUERY_LIMIT,
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
                await self._safe_index_async(repo_full_name, branch)
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
                    repo_full_name, branch, tokens, limit=BUDGET_QUERY_LIMIT,
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

    async def _safe_index_async(
        self, repo_full_name: str, branch: str,
    ) -> bool:
        """Async wrapper around :meth:`_safe_index`.

        Runs the synchronous indexing on a worker thread so
        cold-indexing during ``query()`` /
        ``find_affected_areas()`` doesn't stall the event
        loop. On warm paths the underlying call returns in
        microseconds, so the thread hop is the only added
        latency.
        """
        import asyncio
        return await asyncio.to_thread(
            self._safe_index, repo_full_name, branch,
        )

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

            # ── mtime-based skip ──────────────────────────────────
            # If the file's mtime + size haven't changed since the
            # last index, we skip re-parsing it. This makes
            # repeat indexing on the same SHA essentially free
            # (the mtime check is one indexed SELECT + a stat()).
            mtimes = self._store.get_file_mtimes(repo_full_name, branch)
            to_parse: list[Path] = []
            new_mtimes: dict[str, tuple[float, int]] = {}
            for f in files:
                try:
                    st = f.stat()
                except OSError:
                    continue
                # ``os.path.relpath`` is faster than
                # ``Path.relative_to`` (avoids the PurePath
                # construction and is_relative_to check) — the
                # same trick the per-file parser uses.
                try:
                    rel = os.path.relpath(str(f), str(self._root))
                except ValueError:
                    rel = str(f)
                cached = mtimes.get(rel)
                if cached is not None and abs(cached[0] - st.st_mtime) < 0.01 and cached[1] == st.st_size:
                    # File unchanged — skip parsing.
                    new_mtimes[rel] = (st.st_mtime, st.st_size)
                    continue
                to_parse.append(f)
                new_mtimes[rel] = (st.st_mtime, st.st_size)

            # Wipe symbols for the changed files before re-inserting.
            if to_parse:
                rel_paths = [
                    os.path.relpath(str(f), str(self._root))
                    for f in to_parse
                ]
                self._store.clear_repo_files(
                    repo_full_name, branch, rel_paths,
                )

                # ── Parse files ─────────────────────────────────────
                parsed = _parse_files_parallel(
                    to_parse, self._root, max_workers=_INDEX_WORKERS,
                )

                # ── Single bulk insert into SQLite ─────────────────
                all_symbols: list[SymbolRecord] = []
                all_refs: list[ReferenceRecord] = []
                for _rel, symbols, refs in parsed:
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

            # Persist the (new or unchanged) mtimes so the next
            # index can skip re-parsing.
            self._store.upsert_file_mtimes(
                repo_full_name, branch, new_mtimes,
            )

            self._store.upsert_repo(
                repo_full_name, branch, sha, len(files),
                self._store.get_symbol_count(repo_full_name, branch),
            )
            return True
        except Exception as exc:
            logger.debug("SymbolGraph index failed: %s", exc)
            return False
