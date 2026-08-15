"""M5 (D9): ``invert_unified_diff`` — the guardian's revert primitive.

Property pinned here: for every diff ``d`` in the corpus and base
``b`` where ``d`` applies, ``apply(invert(d), apply(d, b))`` restores
``b`` — modulo the trailing-newline normalization ``_apply_hunks``
itself performs (non-empty output always gains a trailing newline).
Plus: the inverted diff re-parses with the same parser, double-invert
is the identity on canonically-serialized diffs, and ``\\ No newline``
markers survive inversion.
"""

from __future__ import annotations

import pytest

from eden.patches.diff_materializer import (
    _DEV_NULL,
    DiffMaterializeError,
    _apply_hunks,
    _parse_unified_diff_files,
    invert_unified_diff,
)

# ── corpus ──────────────────────────────────────────────────────────
# Written in the canonical serialization ``invert_unified_diff`` emits
# (diff --git header, explicit counts) so double-invert is exact.

MODIFY = (
    "diff --git a/app/checkout.py b/app/checkout.py\n"
    "--- a/app/checkout.py\n"
    "+++ b/app/checkout.py\n"
    "@@ -1,3 +1,3 @@\n"
    " def checkout(total):\n"
    "-    return total / 0\n"
    "+    return total\n"
    " # end\n"
)
MODIFY_BASE = {
    "app/checkout.py": "def checkout(total):\n    return total / 0\n# end\n"
}

MULTI_HUNK = (
    "diff --git a/lib/util.py b/lib/util.py\n"
    "--- a/lib/util.py\n"
    "+++ b/lib/util.py\n"
    "@@ -1,3 +1,4 @@\n"
    " import os\n"
    "+import sys\n"
    " \n"
    " A = 1\n"
    "@@ -8,3 +9,3 @@\n"
    " def g():\n"
    "-    return A\n"
    "+    return A + 1\n"
    " # tail\n"
)
MULTI_HUNK_BASE = {
    "lib/util.py": (
        "import os\n\nA = 1\nB = 2\nC = 3\n\n\ndef g():\n    return A\n# tail\n"
    )
}

NEW_FILE = (
    "diff --git a/pkg/new_mod.py b/pkg/new_mod.py\n"
    "--- /dev/null\n"
    "+++ b/pkg/new_mod.py\n"
    "@@ -0,0 +1,2 @@\n"
    "+def hello():\n"
    "+    return 'hi'\n"
)
NEW_FILE_BASE = {"pkg/new_mod.py": ""}

DELETE = (
    "diff --git a/pkg/old_mod.py b/pkg/old_mod.py\n"
    "--- a/pkg/old_mod.py\n"
    "+++ /dev/null\n"
    "@@ -1,2 +1,0 @@\n"
    "-def bye():\n"
    "-    return 'bye'\n"
)
DELETE_BASE = {"pkg/old_mod.py": "def bye():\n    return 'bye'\n"}

NO_TRAILING_NEWLINE = (
    "diff --git a/notes.txt b/notes.txt\n"
    "--- a/notes.txt\n"
    "+++ b/notes.txt\n"
    "@@ -1,2 +1,2 @@\n"
    " alpha\n"
    "-beta\n"
    "\\ No newline at end of file\n"
    "+beta!\n"
    "\\ No newline at end of file\n"
)
NO_TRAILING_NEWLINE_BASE = {"notes.txt": "alpha\nbeta"}

CORPUS = [
    pytest.param(MODIFY, MODIFY_BASE, id="modify"),
    pytest.param(MULTI_HUNK, MULTI_HUNK_BASE, id="multi-hunk"),
    pytest.param(NEW_FILE, NEW_FILE_BASE, id="new-file"),
    pytest.param(DELETE, DELETE_BASE, id="delete"),
    pytest.param(
        NO_TRAILING_NEWLINE, NO_TRAILING_NEWLINE_BASE, id="no-trailing-newline"
    ),
]


def _apply(diff: str, files: dict[str, str]) -> dict[str, str]:
    """Apply a unified diff to an in-memory file dict via _apply_hunks."""
    out = dict(files)
    for fd in _parse_unified_diff_files(diff):
        if fd.new_path == _DEV_NULL:
            path = fd.old_path or ""
            result = _apply_hunks(out.get(path, ""), fd.hunks, path=path)
            assert not result.strip(), f"delete left residue in {path}"
            out[path] = ""
            continue
        path = (
            fd.new_path
            if fd.new_path and fd.new_path != _DEV_NULL
            else (fd.old_path or "")
        )
        base = "" if fd.old_path == _DEV_NULL else out.get(path, "")
        out[path] = _apply_hunks(base, fd.hunks, path=path)
    return out


def _normalize(content: str) -> str:
    """The trailing-newline normalization _apply_hunks performs."""
    if content and not content.endswith("\n"):
        return content + "\n"
    return content


class TestRoundTripProperty:
    @pytest.mark.parametrize(("diff", "base"), CORPUS)
    def test_apply_then_inverted_restores_base(
        self, diff: str, base: dict[str, str]
    ) -> None:
        applied = _apply(diff, base)
        assert applied != base, "corpus diff must actually change the base"
        restored = _apply(invert_unified_diff(diff), applied)
        assert restored == {p: _normalize(c) for p, c in base.items()}

    @pytest.mark.parametrize(("diff", "base"), CORPUS)
    def test_inverted_diff_reparses(self, diff: str, base: dict[str, str]) -> None:
        original = _parse_unified_diff_files(diff)
        inverted = _parse_unified_diff_files(invert_unified_diff(diff))
        assert len(inverted) == len(original)
        for orig, inv in zip(original, inverted, strict=True):
            assert inv.old_path == orig.new_path
            assert inv.new_path == orig.old_path
            assert len(inv.hunks) == len(orig.hunks)
            for oh, ih in zip(orig.hunks, inv.hunks, strict=True):
                assert (ih.old_start, ih.old_count) == (oh.new_start, oh.new_count)
                assert (ih.new_start, ih.new_count) == (oh.old_start, oh.old_count)

    @pytest.mark.parametrize(("diff", "base"), CORPUS)
    def test_double_invert_is_identity(
        self, diff: str, base: dict[str, str]
    ) -> None:
        assert invert_unified_diff(invert_unified_diff(diff)) == diff


class TestShapes:
    def test_new_file_inverts_to_delete(self) -> None:
        [fd] = _parse_unified_diff_files(invert_unified_diff(NEW_FILE))
        assert fd.old_path == "pkg/new_mod.py"
        assert fd.new_path == _DEV_NULL
        assert all(line.startswith("-") for line in fd.hunks[0].lines)

    def test_delete_inverts_to_new_file(self) -> None:
        [fd] = _parse_unified_diff_files(invert_unified_diff(DELETE))
        assert fd.old_path == _DEV_NULL
        assert fd.new_path == "pkg/old_mod.py"
        assert all(line.startswith("+") for line in fd.hunks[0].lines)

    def test_plus_minus_flip_context_preserved(self) -> None:
        inverted = invert_unified_diff(MODIFY)
        assert "-    return total\n" in inverted
        assert "+    return total / 0\n" in inverted
        assert " def checkout(total):\n" in inverted
        assert " # end\n" in inverted

    def test_no_newline_markers_preserved(self) -> None:
        inverted = invert_unified_diff(NO_TRAILING_NEWLINE)
        assert inverted.count("\\ No newline at end of file") == 2
        # The marker follows its (now flipped) line.
        lines = inverted.splitlines()
        for i, line in enumerate(lines):
            if line.startswith("\\"):
                assert lines[i - 1][0] in "+- "

    def test_empty_diff_inverts_to_empty(self) -> None:
        assert invert_unified_diff("") == ""
        assert invert_unified_diff("   \n") == ""

    def test_binary_diff_raises(self) -> None:
        diff = (
            "diff --git a/logo.png b/logo.png\n"
            "Binary files a/logo.png and b/logo.png differ\n"
        )
        with pytest.raises(DiffMaterializeError):
            invert_unified_diff(diff)

    def test_git_style_headers_survive_semantically(self) -> None:
        """A git-produced diff (index lines, hunk section text) inverts
        to something the applier round-trips, even though the exact
        serialization is canonicalized."""
        diff = (
            "diff --git a/app/checkout.py b/app/checkout.py\n"
            "index 1111111..2222222 100644\n"
            "--- a/app/checkout.py\n"
            "+++ b/app/checkout.py\n"
            "@@ -1,3 +1,3 @@ def checkout\n"
            " def checkout(total):\n"
            "-    return total / 0\n"
            "+    return total\n"
            " # end\n"
        )
        applied = _apply(diff, MODIFY_BASE)
        restored = _apply(invert_unified_diff(diff), applied)
        assert restored == MODIFY_BASE
