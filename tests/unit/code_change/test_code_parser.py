"""Tests for :mod:`eden.code_change.code_parser`.

Covers the stdlib-``ast`` Python extractor + the
deferred-grammar JS/TS stub. The Cat 23 v1.6 ship plan
calls for tree-sitter across Python + JS + TS but we
ship the Python extractor via stdlib ``ast`` first —
zero new deps, handles every CPython-supported
grammar (decorators, async, nested defs, classes).
JS/TS support is a deferred gate per the v1.6 plan.
"""

from __future__ import annotations

from eden.code_change.code_parser import (
    extract_function_range,
    first_function_def,
)


# ── Basic extraction ─────────────────────────────────────────


def test_extract_simple_def() -> None:
    """A plain ``def`` returns the start..end lines."""
    src = (
        "def foo():\n"
        "    pass\n"
    )
    assert extract_function_range(src, "python", "foo") == (1, 2)


def test_extract_top_level_def_among_others() -> None:
    """The right function is found when multiple defs exist."""
    src = (
        "def foo():\n"
        "    pass\n"
        "\n"
        "def bar():\n"
        "    pass\n"
    )
    assert extract_function_range(src, "python", "foo") == (1, 2)
    assert extract_function_range(src, "python", "bar") == (4, 5)


def test_extract_returns_zero_zero_on_missing_function() -> None:
    """A name that doesn't appear returns the ``(0, 0)`` sentinel."""
    src = "def foo():\n    pass\n"
    assert extract_function_range(src, "python", "bar") == (0, 0)


# ── Decorators + async ────────────────────────────────────────


def test_extract_decorated_function_starts_at_decorator() -> None:
    """The range starts at the first decorator, not the ``def``."""
    src = (
        "@decorator\n"
        "@another\n"
        "def foo():\n"
        "    pass\n"
    )
    assert extract_function_range(src, "python", "foo") == (1, 4)


def test_extract_async_function() -> None:
    """``async def`` is treated as a function definition."""
    src = (
        "async def fetch():\n"
        "    return 42\n"
    )
    assert extract_function_range(src, "python", "fetch") == (1, 2)


def test_extract_decorated_async_function() -> None:
    """Decorators + async combine cleanly."""
    src = (
        "@retry\n"
        "async def fetch():\n"
        "    if True:\n"
        "        return 1\n"
        "    return 2\n"
    )
    assert extract_function_range(src, "python", "fetch") == (1, 5)


# ── Nested defs ───────────────────────────────────────────────


def test_extract_nested_def_returns_innermost() -> None:
    """A nested def with the same name wins over the outer one."""
    src = (
        "def foo():\n"                # line 1
        "    pass\n"                   # line 2
        "\n"
        "def baz():\n"                # line 4
        "    def foo():\n"            # line 5
        "        return 42\n"          # line 6
        "    return foo()\n"           # line 7
    )
    # The walker recurses into ``baz`` first, finds the
    # nested ``foo``, and returns it.
    assert extract_function_range(src, "python", "foo") == (5, 6)


# ── Class methods ─────────────────────────────────────────────


def test_extract_class_method() -> None:
    """Methods inside a class are reachable via the recursive walk."""
    src = (
        "class C:\n"                  # line 1
        "    def method(self):\n"     # line 2
        "        return 1\n"           # line 3
    )
    assert extract_function_range(src, "python", "method") == (2, 3)


# ── Edge cases ────────────────────────────────────────────────


def test_extract_empty_string_returns_zero_zero() -> None:
    """Empty input is the ``(0, 0)`` sentinel."""
    assert extract_function_range("", "python", "foo") == (0, 0)


def test_extract_empty_function_name_returns_zero_zero() -> None:
    """An empty function name is the ``(0, 0)`` sentinel."""
    src = "def foo():\n    pass\n"
    assert extract_function_range(src, "python", "") == (0, 0)


def test_extract_syntax_error_returns_zero_zero() -> None:
    """A file with a SyntaxError doesn't crash — returns ``(0, 0)``."""
    src = "def foo(:\n    pass\n"  # invalid syntax
    assert extract_function_range(src, "python", "foo") == (0, 0)


def test_extract_returns_zero_zero_for_unsupported_language() -> None:
    """JS/TS is deferred — returns ``(0, 0)`` (the caller persists empty)."""
    src = "def foo():\n    pass\n"
    assert extract_function_range(src, "javascript", "foo") == (0, 0)
    assert extract_function_range(src, "typescript", "foo") == (0, 0)


# ── first_function_def ────────────────────────────────────────


def test_first_function_def_returns_first_def() -> None:
    """``first_function_def`` returns the FIRST def in the file."""
    src = (
        "def foo():\n"
        "    pass\n"
        "\n"
        "def bar():\n"
        "    pass\n"
    )
    assert first_function_def(src) == ("foo", (1, 2))


def test_first_function_def_returns_class_method_first() -> None:
    """A class method counts as a def for ``first_function_def``."""
    src = (
        "class C:\n"
        "    def method(self):\n"
        "        return 1\n"
    )
    assert first_function_def(src) == ("method", (2, 3))


def test_first_function_def_returns_empty_on_no_defs() -> None:
    """A file with only statements returns ``("", (0, 0))``."""
    src = "x = 1\ny = 2\n"
    assert first_function_def(src) == ("", (0, 0))


def test_first_function_def_returns_empty_on_unsupported_language() -> None:
    """JS/TS is deferred — ``first_function_def`` returns the sentinel."""
    src = "function foo() { return 1; }"
    assert first_function_def(src, language="javascript") == ("", (0, 0))


def test_first_function_def_returns_empty_on_syntax_error() -> None:
    """A file with a SyntaxError returns the sentinel."""
    src = "def foo(:\n    pass\n"
    assert first_function_def(src) == ("", (0, 0))


# ── Real-world fixture ────────────────────────────────────────


def test_extract_handles_real_python_module_shape() -> None:
    """A module with imports + defs + main block behaves correctly."""
    src = (
        "import os\n"                  # 1
        "from typing import Any\n"     # 2
        "\n"
        "logger = ...\n"               # 4
        "\n"
        "@retry\n"                     # 6
        "async def fetch(url):\n"     # 7
        "    try:\n"                   # 8
        "        return 1\n"           # 9
        "    except Exception:\n"     # 10
        "        return None\n"        # 11
    )
    assert extract_function_range(src, "python", "fetch") == (6, 11)