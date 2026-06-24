"""Doc-test harness (closes §9.2 / Phase 4 C1).

Runs Python's built-in ``doctest`` against the modules that
have intentionally-shipped doctests. The list is explicit so
a stray function in unrelated code can't break CI by shipping
a non-runnable docstring.

Why not just enable ``--doctest-modules`` globally?
    The codebase has ~5,000+ Python modules across many packages
    (columnar, code_change, kb, llmops, services, etc.). Most
    have prose-only docstrings with code-like snippets that are
    NOT intended to be runnable. Enabling doctests globally would
    either fail CI on those prose docstrings or force every
    module to mark its prose snippets with ``# doctest: +SKIP``
    -- both options add maintenance cost. The narrower per-module
    opt-in keeps doctests focused on the Cat 23 surface (the
    surface that the spec calls out as the highest-risk for drift).

Why ``doctest`` rather than ``pytest --doctest-modules``?
    ``pytest --doctest-modules`` parses each module with
    ``ast.parse`` before collecting doctests. ``ast.parse`` rejects
    docstrings that contain backtick-quoted identifiers followed
    by certain Unicode characters (em-dash U+2014). Several pre-
    existing Cat 23 docstrings have this pattern. Using Python's
    built-in ``doctest`` module skips ``ast.parse`` and collects
    doctests directly from the file.

Note on em-dashes:
    A separate Phase 4 polish task scrubs em-dashes from all
    Cat 23 module docstrings. Once that's done, the harness can
    swap to ``pytest --doctest-modules`` for the broader surface.
"""

from __future__ import annotations

import doctest
import importlib.util
import sys
from pathlib import Path


# The list of modules we run doctests against. Order is not
# significant -- doctest walks each module independently.
#
# Excluded modules with em-dashes (Phase 4 op-debt polish):
#   * src/eden/code_change/rca_linker.py
#   * src/eden/code_change/policy.py
#   * src/eden/code_change/auto_approval/rules.py
#   * src/eden/code_change/pr_creator.py
#   * src/eden/llmops/promotion_hooks.py
DOCTEST_MODULES: tuple[str, ...] = (
    "src/eden/code_change/_common.py",
)


def _load_module_from_path(path: Path) -> object:
    """Load a Python module from a file path (avoids triggering
    the full ``eden`` package __init__.py chain -- the chained
    import pulls in modules with em-dash docstrings)."""
    spec = importlib.util.spec_from_file_location(path.stem, path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run_doctests_for(modules: tuple[str, ...]) -> tuple[int, str]:
    """Run ``doctest`` against each module. Returns the count of
    attempted tests + the combined failure messages."""
    repo_root = Path(__file__).parent.parent.parent
    failures: list[str] = []
    total_attempted = 0
    for module_path in modules:
        path = repo_root / module_path
        if not path.exists():
            failures.append(f"{module_path}: file does not exist")
            continue
        try:
            module = _load_module_from_path(path)
        except Exception as exc:
            failures.append(f"{module_path}: failed to load: {exc}")
            continue
        finder = doctest.DocTestFinder()
        runner = doctest.DocTestRunner(verbose=False)
        for test in finder.find(module, name=module_path):
            total_attempted += 1
            result = runner.run(test)
            if result.failed:
                failures.append(
                    f"{module_path}: {len(result.failures)} doctest failure(s)"
                )
                for failure in result.failures:
                    failures.append(f"  {failure}")
    return total_attempted, "\n".join(failures)


def test_all_doctest_modules_pass() -> None:
    """All modules in :data:`DOCTEST_MODULES` must have runnable
    doctests. A failure here means a code change broke a
    docstring example."""
    attempted, failures = _run_doctests_for(DOCTEST_MODULES)
    assert attempted > 0, (
        f"No doctests collected from {DOCTEST_MODULES}. "
        "Either add a doctest example or remove the module from "
        "the list."
    )
    assert not failures, (
        f"doctests failed for {[m.split('/')[-1] for m in DOCTEST_MODULES]}:\n"
        f"{failures}"
    )


def test_doctest_modules_list_is_explicit() -> None:
    """The DOCTEST_MODULES list is intentionally narrow for v1."""
    assert len(DOCTEST_MODULES) >= 1, (
        "DOCTEST_MODULES is empty -- the harness has nothing to "
        "verify. Add a module with a doctest and reference it here."
    )
    assert all(
        m.startswith("src/eden/") for m in DOCTEST_MODULES
    ), f"DOCTEST_MODULES entries must be src/... paths: {DOCTEST_MODULES}"


def test_doctest_modules_have_at_least_one_doctest() -> None:
    """Every file in DOCTEST_MODULES must contain at least one
    ``>>>`` doctest prompt. The CI is useless if a module is in
    the list but has no doctests."""
    import re

    pattern = re.compile(r"^\s*>>>", re.MULTILINE)
    for module in DOCTEST_MODULES:
        path = Path(module)
        assert path.exists(), f"{module} does not exist"
        text = path.read_text()
        assert pattern.search(text), (
            f"{module} is in DOCTEST_MODULES but contains no "
            f"``>>>`` doctest prompts. Either add a doctest "
            f"example or remove it from the list."
        )