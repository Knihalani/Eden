"""Systemic dead-function sweep (2026-08-11).

For every function / async function / method defined in src/eden, count how many
times its name appears OUTSIDE its defining file (token-level, word-boundary).
Functions with zero external references are potentially dead code — the same
pattern that caught `run_due_sweeps` and `pick_canary_version`.

Reports two buckets:
  A) zero refs anywhere outside defining file (excluding the def itself)
  B) zero refs in src/, referenced only from tests/ (dead in prod, kept for tests)
"""

import ast
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "eden"
TESTS = ROOT / "tests"

WORD = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\b")


def iter_funcs(path: pathlib.Path):
    """Yield (name, line, kind) for every function/method def in a file."""
    try:
        tree = ast.parse(path.read_text(errors="ignore"))
    except SyntaxError:
        return
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            yield node.name, node.lineno


def count_words(text: str, name: str) -> int:
    return len(WORD.findall(text))


def main() -> None:
    src_files = list(SRC.rglob("*.py"))
    test_files = list(TESTS.rglob("*.py"))

    # name -> set of defining files
    defined_in: dict[str, set[pathlib.Path]] = {}
    for f in src_files:
        for name, _line in iter_funcs(f):
            defined_in.setdefault(name, set()).add(f)

    # name -> set of files mentioning it (src + tests), and src-only counts
    mentioned_src: dict[str, set[pathlib.Path]] = {}
    mentioned_test: dict[str, set[pathlib.Path]] = {}
    src_text_cache: dict[pathlib.Path, str] = {}
    for f in src_files:
        text = f.read_text(errors="ignore")
        src_text_cache[f] = text
        for name in defined_in:
            if name in text:
                mentioned_src.setdefault(name, set()).add(f)
    for f in test_files:
        text = f.read_text(errors="ignore")
        for name in defined_in:
            if name in text:
                mentioned_test.setdefault(name, set()).add(f)

    bucket_a: list[tuple[str, list[str], int]] = []
    bucket_b: list[tuple[str, list[str], int]] = []
    for name, def_files in sorted(defined_in.items()):
        if name.startswith("_") and not name.startswith("__"):
            # private helpers: skip (convention allows file-local underscore fns)
            continue
        def_paths = [str(f.relative_to(ROOT)) for f in sorted(def_files)]
        ext_src = (mentioned_src.get(name) or set()) - def_files
        ext_test = (mentioned_test.get(name) or set())
        if not ext_src and not ext_test:
            bucket_a.append((name, def_paths, len(def_files)))
        elif not ext_src and ext_test:
            bucket_b.append((name, def_paths, len(def_files)))

    print("=== A) ZERO references anywhere outside defining file(s) ===")
    for name, defs, _n in bucket_a:
        print(f"  {name}  [defined in: {', '.join(defs[:3])}]")
    print(f"  ({len(bucket_a)} total)")

    print()
    print("=== B) referenced only from tests/ (dead in prod) ===")
    for name, defs, _n in bucket_b:
        print(f"  {name}  [defined in: {', '.join(defs[:3])}]")
    print(f"  ({len(bucket_b)} total)")


if __name__ == "__main__":
    sys.exit(main())
