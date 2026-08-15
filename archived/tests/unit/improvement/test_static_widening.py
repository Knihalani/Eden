"""M7 (§4.5) — static coverage widening: yaml/toml + balance heuristic."""

from __future__ import annotations

import pytest

from eden.improvement.evidence_plane import apply_diff_to_files, static_check_files


def _one(path: str, content: str, *, hunk_ranges=None):
    return static_check_files([{"path": path, "content": content}], hunk_ranges=hunk_ranges)


# ── YAML ────────────────────────────────────────────────────────


def test_yaml_valid_passes() -> None:
    result = _one("config/app.yaml", "a: 1\nb:\n  - x\n  - y\n")
    assert result["status"] == "passed"
    assert result["files_checked"] == 1


def test_yaml_invalid_fails() -> None:
    result = _one("config/app.yml", "a: [1, 2\nb: }{\n")
    assert result["status"] == "failed"
    assert result["errors"][0]["kind"] == "yaml_syntax"


# ── TOML ────────────────────────────────────────────────────────


def test_toml_valid_passes() -> None:
    result = _one("pyproject.toml", '[tool.x]\nname = "y"\n')
    assert result["status"] == "passed"
    assert result["files_checked"] == 1


def test_toml_invalid_fails() -> None:
    result = _one("pyproject.toml", "[tool.x\nname = \n")
    assert result["status"] == "failed"
    assert result["errors"][0]["kind"] == "toml_syntax"


# ── Balance heuristic: TS / JS / Go ─────────────────────────────

TRUNCATED_TS = 'export function f() {\n  if (x) {\n    console.log("hi");\n'


def test_truncated_ts_caught_when_hunks_touch() -> None:
    result = _one(
        "src/app.ts",
        TRUNCATED_TS,
        hunk_ranges={"src/app.ts": [(1, 3)]},
    )
    assert result["status"] == "failed"
    kinds = {e["kind"] for e in result["errors"]}
    assert kinds == {"balance_heuristic"}


def test_truncated_ts_without_hunk_info_is_warning() -> None:
    # No hunk info → imbalance not attributable to the patch → warning.
    result = _one("src/app.ts", TRUNCATED_TS)
    assert result["status"] == "passed"
    assert result["warnings"]
    assert result["warnings"][0]["kind"] == "balance_heuristic"


def test_unbalanced_outside_hunks_is_warning_not_failure() -> None:
    # Pre-existing unclosed brace at line 1; the patch touches lines
    # 8-9 only (far from both the opener and EOF) → warning, not failure.
    content = (
        "function outer() {\n"  # 1 — never closed (pre-existing)
        "const a = 1;\n"  # 2
        "const b = 2;\n"  # 3
        "const c = 3;\n"  # 4
        "const d = 4;\n"  # 5
        "const e = 5;\n"  # 6
        "const f0 = 6;\n"  # 7
        "const g = 7;\n"  # 8
        "const h = 8;\n"  # 9
        "const i = 9;\n"  # 10
        "const j = 10;\n"  # 11
        "const k = 11;\n"  # 12
        "const l = 12;\n"  # 13
    )
    result = _one("src/app.ts", content, hunk_ranges={"src/app.ts": [(8, 9)]})
    assert result["status"] == "passed"
    assert result["warnings"]
    assert "unclosed" in result["warnings"][0]["message"]


def test_go_unbalanced_caught() -> None:
    content = 'package main\n\nfunc main() {\n\tfmt.Println("hi")\n'
    result = _one(
        "cmd/main.go", content, hunk_ranges={"cmd/main.go": [(4, 5)]}
    )
    assert result["status"] == "failed"
    assert result["errors"][0]["kind"] == "balance_heuristic"


def test_balanced_ts_with_strings_and_comments_passes() -> None:
    content = (
        "// keep } and ( in comments out of it\n"
        "/* also { in block comments */\n"
        "const s = \"a } string with ) brackets\";\n"
        "const t = `template ${x} with { braces }`;\n"
        "function f(a: number): number {\n"
        "  return (a + 1);\n"
        "}\n"
    )
    result = _one("src/ok.tsx", content)
    assert result["status"] == "passed"
    assert not result["warnings"]


def test_unterminated_string_caught() -> None:
    content = 'const a = "unterminated;\nconst b = 1;\n'
    result = _one("src/app.js", content, hunk_ranges={"src/app.js": [(1, 1)]})
    assert result["status"] == "failed"
    assert "unterminated" in result["errors"][0]["message"]


def test_mismatched_closer_caught() -> None:
    content = "function f() {\n  return [1, 2);\n}\n"
    result = _one("src/app.js", content, hunk_ranges={"src/app.js": [(2, 2)]})
    assert result["status"] == "failed"
    assert "mismatched" in result["errors"][0]["message"]


def test_python_and_json_behavior_unchanged() -> None:
    ok = static_check_files(
        [
            {"path": "a.py", "content": "def f():\n    return 1\n"},
            {"path": "b.json", "content": '{"a": 1}'},
            {"path": "c.rs", "content": "fn main() {"},
        ]
    )
    assert ok["status"] == "passed"
    assert ok["files_checked"] == 2
    assert ok["files_skipped"] == 1  # .rs still skipped-with-label


# ── Through apply_diff_to_files (hunk ranges computed from the diff) ─


@pytest.mark.asyncio
async def test_apply_diff_truncating_ts_fails_static() -> None:
    base = 'export function f() {\n  console.log("hi");\n}\n'
    diff = (
        "--- a/src/app.ts\n"
        "+++ b/src/app.ts\n"
        "@@ -1,3 +1,2 @@\n"
        " export function f() {\n"
        '   console.log("hi");\n'
        "-}\n"
    )
    result = await apply_diff_to_files(diff, [{"path": "src/app.ts", "content": base}])
    assert result["status"] == "failed"
    assert result["detail"]["reason"] == "static_syntax_failed"
    errors = result["detail"]["static_check"]["errors"]
    assert errors and errors[0]["kind"] == "balance_heuristic"


@pytest.mark.asyncio
async def test_apply_diff_clean_ts_change_passes() -> None:
    base = 'export function f() {\n  console.log("hi");\n}\n'
    diff = (
        "--- a/src/app.ts\n"
        "+++ b/src/app.ts\n"
        "@@ -1,3 +1,3 @@\n"
        " export function f() {\n"
        '-  console.log("hi");\n'
        '+  console.log("hello");\n'
        " }\n"
    )
    result = await apply_diff_to_files(diff, [{"path": "src/app.ts", "content": base}])
    assert result["status"] == "passed"
    assert result["detail"]["static_check"]["status"] == "passed"
