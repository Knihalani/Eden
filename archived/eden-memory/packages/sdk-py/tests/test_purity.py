"""Purity test: the eden package must be pure Python stdlib (>= 3.9)."""

from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

PACKAGE_DIR = Path(__file__).resolve().parents[1] / "eden"

# Every top-level module the package may import. Anything outside this set
# (requests, httpx, pydantic, ...) fails the suite.
ALLOWED = {
    "__future__",
    "asyncio",
    "functools",
    "inspect",
    "json",
    "os",
    "threading",
    "time",
    "typing",
    "urllib",
    "uuid",
}


class PurityTests(unittest.TestCase):
    def test_only_stdlib_imports(self) -> None:
        found: set[str] = set()
        for path in sorted(PACKAGE_DIR.rglob("*.py")):
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = [alias.name.split(".")[0] for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                    names = [node.module.split(".")[0]]
                else:
                    continue
                found.update(names)
        self.assertTrue(found, "no imports found — did the package move?")
        offenders = sorted(found - ALLOWED)
        self.assertEqual(offenders, [], f"non-stdlib or unexpected imports: {offenders}")

    def test_public_surface_exports(self) -> None:
        package_root = str(Path(__file__).resolve().parents[1])
        saved = sys.path[:]
        sys.path.insert(0, package_root)
        try:
            import eden  # noqa: PLC0415 - deliberate local import

            for name in ("EdenClient", "EdenError", "wrap_tools", "run_tool"):
                self.assertTrue(hasattr(eden, name), f"missing public export: {name}")
        finally:
            sys.path[:] = saved


if __name__ == "__main__":
    unittest.main()
