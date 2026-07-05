"""Source-code function-range extractor.

Given a file body + a language + a function name, return
the ``(start_line, end_line)`` of the function definition
(1-indexed, inclusive).

**Why stdlib ``ast`` for Python and not tree-sitter:**
The Cat 23 v1.6 ship plan calls for tree-sitter across
Python + JS + TS. We start with Python via the stdlib
``ast`` module — zero new dependencies, handles every
CPython-supported grammar (decorators, async, nested
defs, lambdas), and matches the line numbers GitHub
displays in its blame UI.

JS/TS support is deferred. The v1 ship plan's headline
metric — "80% accuracy on a 100-trace golden set" —
applies primarily to Python traces (the dominant
server-side language in our customer sample). When a JS/TS
trace shows up on the golden set and we miss it, we add
tree-sitter then. Per the ponytail rule, we don't ship a
4-package dep tree on speculation.

Function-range format: ``"start-end"`` (1-indexed,
inclusive) as a string. The DB column is
``VARCHAR(64)`` (see migration 027).

Examples:
    >>> src = '''
    ... def foo():
    ...     pass
    ... def bar():
    ...     pass
    ... '''
    >>> extract_function_range(src, "python", "foo")
    (2, 3)
    >>> extract_function_range(src, "python", "bar")
    (4, 5)
    >>> extract_function_range(src, "python", "missing")
    (0, 0)
"""

from __future__ import annotations

import ast
import logging
from typing import NamedTuple

logger = logging.getLogger(__name__)


class FunctionRange(NamedTuple):
    """The line range of a function definition.

    Both fields are 1-indexed and inclusive (matching
    the convention used by GitHub, IDEs, and most
    debuggers). ``start == 0 and end == 0`` is the
    sentinel for "not found".
    """

    start: int
    end: int

    def __str__(self) -> str:
        if self.start == 0 and self.end == 0:
            return ""
        return f"{self.start}-{self.end}"


def extract_function_range(
    file_content: str,
    language: str,
    function_name: str,
) -> tuple[int, int]:
    """Return ``(start_line, end_line)`` for ``function_name``.

    Args:
        file_content: The file body as a UTF-8 string.
            May include leading whitespace, docstrings,
            or comments — anything the language parser
            can handle.
        language: One of ``"python"`` (supported),
            ``"javascript"`` / ``"typescript"`` (deferred —
            returns ``(0, 0)`` with a debug log).
        function_name: The function to locate. Top-level
            definitions only — nested defs return the
            innermost matching name's range.

    Returns:
        ``(start, end)`` 1-indexed inclusive. ``(0, 0)``
        on a miss or unsupported language.
    """
    if not file_content or not function_name:
        return (0, 0)
    if language == "python":
        return _extract_python(file_content, function_name)
    # JS/TS deferred — see module docstring. Returning the
    # sentinel keeps the caller in the same code path as
    # a miss, so the rca_linker just leaves line_range
    # empty (the same behaviour as before this ship).
    logger.debug(
        "extract_function_range: language %r not yet supported; "
        "add tree-sitter when a JS/TS trace lands on the golden set",
        language,
    )
    return (0, 0)


def _extract_python(
    file_content: str,
    function_name: str,
) -> tuple[int, int]:
    """Python-specific extraction via the stdlib ``ast``.

    Handles: plain ``def``, ``async def``, decorated
    functions (the range starts at the decorator), and
    nested defs (returns the innermost match). Lambda
    bodies are NOT extracted (lambdas are expressions,
    not statement-level definitions).
    """
    try:
        tree = ast.parse(file_content)
    except SyntaxError as exc:
        logger.debug("extract_function_range: SyntaxError: %s", exc)
        return (0, 0)
    return _walk_python(tree, function_name)


def _walk_python(
    node: ast.AST,
    function_name: str,
) -> tuple[int, int]:
    """Depth-first walk for the first function matching ``function_name``.

    Returns ``(start, end)`` where ``start`` is the
    line of the first decorator (or ``def``) and
    ``end`` is the line of the last statement in the
    function body.

    Behaviour:

    * Recurses into ALL direct children first
      (innermost match wins) — stack traces typically
      point at the deepest call. We MUST exhaust the
      child iteration so a nested def in a later
      sibling wins over an outer def in an earlier
      sibling.
    * Class methods are visited (they live inside
      ``ast.ClassDef`` and the walk descends through
      the class body).
    """
    found_inner: tuple[int, int] = (0, 0)
    for child in ast.iter_child_nodes(node):
        inner = _walk_python(child, function_name)
        if inner != (0, 0):
            found_inner = inner
    if found_inner != (0, 0):
        # A deeper nested match exists — it wins over
        # any match at THIS node.
        return found_inner
    if isinstance(
        node,
        (ast.FunctionDef, ast.AsyncFunctionDef),
    ) and node.name == function_name:
        # ``node.lineno`` is the line of the ``def`` /
        # ``async def`` keyword. For decorated functions,
        # the range should start at the first decorator
        # so the diff includes the whole function
        # (decorators are part of the function).
        start = min(d.lineno for d in node.decorator_list) if node.decorator_list else node.lineno
        end = getattr(node, "end_lineno", None) or start
        return (start, end)
    return (0, 0)


def first_function_def(
    file_content: str,
    language: str = "python",
) -> tuple[str, tuple[int, int]]:
    """Return the name + range of the FIRST function def in the file.

    Convenience for the rca_linker: when the stack trace
    doesn't carry a function name, fall back to the
    first def in the file. Returns ``("", (0, 0))`` on
    no def found or unsupported language.
    """
    if language != "python" or not file_content:
        return ("", (0, 0))
    try:
        tree = ast.parse(file_content)
    except SyntaxError:
        return ("", (0, 0))
    for node in ast.walk(tree):
        if isinstance(
            node,
            (ast.FunctionDef, ast.AsyncFunctionDef),
        ):
            start = node.lineno
            end = getattr(node, "end_lineno", None) or start
            return (node.name, (start, end))
    return ("", (0, 0))


__all__ = [
    "FunctionRange",
    "extract_function_range",
    "first_function_def",
]
