"""Materialize unified diffs into full file contents for PR commits.

GitHub has no apply-patch API. Approve flows must turn a unified
diff into full :class:`~eden.providers.repo.FileEntry` payloads by
reading base files from a :class:`~eden.providers.repo.RepoProvider`
(or injectable ``read_file``) and applying hunks in pure Python.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from eden.providers.repo import FileEntry

ReadFileFn = Callable[[str], Awaitable[str]]

_HUNK_RE = re.compile(
    r"^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s@@"
)
_DEV_NULL = "/dev/null"


class DiffMaterializeError(ValueError):
    """Raised when a unified diff cannot be applied safely."""


@dataclass
class _Hunk:
    old_start: int
    old_count: int
    new_start: int
    new_count: int
    lines: list[str] = field(default_factory=list)


@dataclass
class _FileDiff:
    old_path: str | None
    new_path: str | None
    hunks: list[_Hunk] = field(default_factory=list)
    is_binary: bool = False


def _strip_prefix(path: str) -> str:
    """Strip ``a/`` / ``b/`` prefixes from unified-diff paths."""
    if path.startswith("a/") or path.startswith("b/"):
        return path[2:]
    return path


def _parse_path_line(line: str, prefix: str) -> str | None:
    """Parse ``--- a/path`` / ``+++ b/path`` into a repo-relative path."""
    if not line.startswith(prefix):
        return None
    rest = line[len(prefix):].strip()
    if not rest:
        return None
    # Timestamps after a tab are ignored.
    path = rest.split("\t", 1)[0].strip()
    if path == _DEV_NULL:
        return _DEV_NULL
    return _strip_prefix(path)


def _parse_unified_diff_files(diff: str) -> list[_FileDiff]:
    """Parse a unified diff into per-file structures (no I/O)."""
    if not diff or not diff.strip():
        return []

    files: list[_FileDiff] = []
    current: _FileDiff | None = None
    current_hunk: _Hunk | None = None

    def _flush_hunk() -> None:
        nonlocal current_hunk
        if current is not None and current_hunk is not None:
            current.hunks.append(current_hunk)
        current_hunk = None

    def _flush_file() -> None:
        nonlocal current
        _flush_hunk()
        if current is not None:
            files.append(current)
        current = None

    for raw in diff.splitlines():
        line = raw.rstrip("\n")
        if line.startswith("diff --git "):
            _flush_file()
            current = _FileDiff(old_path=None, new_path=None)
            continue
        if "Binary files " in line and " differ" in line:
            if current is None:
                current = _FileDiff(old_path=None, new_path=None)
            current.is_binary = True
            continue
        if line.startswith("GIT binary patch"):
            if current is None:
                current = _FileDiff(old_path=None, new_path=None)
            current.is_binary = True
            continue
        if line.startswith("--- "):
            if current is None:
                current = _FileDiff(old_path=None, new_path=None)
            _flush_hunk()
            current.old_path = _parse_path_line(line, "--- ")
            continue
        if line.startswith("+++ "):
            if current is None:
                current = _FileDiff(old_path=None, new_path=None)
            _flush_hunk()
            current.new_path = _parse_path_line(line, "+++ ")
            continue
        m = _HUNK_RE.match(line)
        if m:
            if current is None:
                current = _FileDiff(old_path=None, new_path=None)
            _flush_hunk()
            current_hunk = _Hunk(
                old_start=int(m.group(1)),
                old_count=int(m.group(2) if m.group(2) is not None else 1),
                new_start=int(m.group(3)),
                new_count=int(m.group(4) if m.group(4) is not None else 1),
            )
            continue
        if current_hunk is not None and (
            line.startswith(" ")
            or line.startswith("+")
            or line.startswith("-")
            or line == "\\"
            or line.startswith("\\ ")
        ):
            # Preserve "No newline at end of file" markers as data lines
            # only when they are true hunk body; otherwise skip.
            if line.startswith("\\"):
                continue
            current_hunk.lines.append(line)
            continue

    _flush_file()
    return files


def _split_lines(content: str) -> list[str]:
    """Split file content into lines without keeping trailing newlines."""
    if content == "":
        return []
    # Preserve whether the file ended with a newline by treating
    # splitlines() output as the line bodies; rejoin with \\n later.
    return content.splitlines()


def _join_lines(lines: list[str], *, trailing_newline: bool) -> str:
    if not lines:
        return ""
    body = "\n".join(lines)
    return body + ("\n" if trailing_newline else "")


def _apply_hunks(base: str, hunks: list[_Hunk], *, path: str) -> str:
    """Apply unified-diff hunks to ``base``. Fail closed on mismatch."""
    if not hunks:
        return base

    trailing_newline = base.endswith("\n") if base else True
    source = _split_lines(base)
    # Cursor into source is 0-based; hunk old_start is 1-based.
    out: list[str] = []
    cursor = 0

    for hunk in hunks:
        # Copy untouched prefix up to hunk start.
        target = max(hunk.old_start - 1, 0)
        if target < cursor:
            raise DiffMaterializeError(
                f"hunk overlap or out-of-order at {path}"
            )
        if target > len(source):
            raise DiffMaterializeError(
                f"hunk start past end of file for {path}"
            )
        out.extend(source[cursor:target])
        cursor = target

        old_seen = 0
        new_seen = 0
        for raw in hunk.lines:
            tag = raw[0] if raw else " "
            text = raw[1:] if raw else ""
            if tag == " ":
                if cursor >= len(source) or source[cursor] != text:
                    raise DiffMaterializeError(
                        f"context mismatch applying hunk to {path}"
                    )
                out.append(source[cursor])
                cursor += 1
                old_seen += 1
                new_seen += 1
            elif tag == "-":
                if cursor >= len(source) or source[cursor] != text:
                    raise DiffMaterializeError(
                        f"context mismatch removing line in {path}"
                    )
                cursor += 1
                old_seen += 1
            elif tag == "+":
                out.append(text)
                new_seen += 1
            else:
                raise DiffMaterializeError(
                    f"invalid hunk line in {path}: {raw!r}"
                )

        if hunk.old_count and old_seen != hunk.old_count:
            raise DiffMaterializeError(
                f"old-count mismatch for {path}: "
                f"expected {hunk.old_count}, got {old_seen}"
            )
        if hunk.new_count and new_seen != hunk.new_count:
            raise DiffMaterializeError(
                f"new-count mismatch for {path}: "
                f"expected {hunk.new_count}, got {new_seen}"
            )

    out.extend(source[cursor:])
    # Prefer trailing newline when the result is non-empty (git default).
    if out:
        trailing_newline = True
    return _join_lines(out, trailing_newline=trailing_newline)


def _is_binary_content(content: str) -> bool:
    return "\0" in content


async def materialize_unified_diff(
    diff: str,
    *,
    read_file: ReadFileFn,
) -> list[FileEntry]:
    """Turn a unified diff into full :class:`FileEntry` contents.

    Args:
        diff: Unified diff text (possibly multi-file).
        read_file: Async ``path -> content`` reader. Missing files
            should return ``""`` (same contract as
            :meth:`RepoProvider.read_file`).

    Returns:
        One :class:`FileEntry` per touched path. Deleted files are
        included with empty ``content`` so callers can decide how
        to encode the delete in the PR provider.

    Raises:
        DiffMaterializeError: On binary diffs, missing base for a
            modify, or hunk context mismatch.
    """
    parsed = _parse_unified_diff_files(diff)
    if not parsed:
        return []

    for fd in parsed:
        if fd.is_binary:
            raise DiffMaterializeError("binary diff is not supported")

    # Paths that need a base read (modifies + deletes). New files
    # (old == /dev/null) skip the fetch.
    need_base: list[str] = []
    for fd in parsed:
        old = fd.old_path
        new = fd.new_path
        if old and old != _DEV_NULL:
            need_base.append(old)
        elif new and new != _DEV_NULL and old is None:
            # Incomplete headers — treat as modify of new path.
            need_base.append(new)

    unique_paths = list(dict.fromkeys(need_base))
    bases: dict[str, str] = {}
    if unique_paths:
        contents = await asyncio.gather(
            *[read_file(p) for p in unique_paths]
        )
        bases = dict(zip(unique_paths, contents, strict=True))

    entries: list[FileEntry] = []
    for fd in parsed:
        old = fd.old_path
        new = fd.new_path
        is_new = old == _DEV_NULL
        is_delete = new == _DEV_NULL

        if is_delete:
            path = old if old and old != _DEV_NULL else None
            if not path:
                raise DiffMaterializeError("delete hunk missing old path")
            base = bases.get(path, "")
            if base == "" and any(h.old_count > 0 for h in fd.hunks):
                raise DiffMaterializeError(
                    f"missing base file for modify: {path}"
                )
            if _is_binary_content(base):
                raise DiffMaterializeError(f"binary file not supported: {path}")
            # Verify hunks apply (result should be empty), then signal delete.
            remaining = _apply_hunks(base, fd.hunks, path=path)
            if remaining.strip():
                raise DiffMaterializeError(
                    f"delete of {path} left residual content"
                )
            entries.append(
                FileEntry(path=path, size=0, sha="", content="")
            )
            continue

        path = (
            new
            if new and new != _DEV_NULL
            else (old if old and old != _DEV_NULL else None)
        )
        if not path:
            raise DiffMaterializeError("file hunk missing path")

        if is_new:
            base = ""
        else:
            base = bases.get(path, "")
            if base == "" and any(h.old_count > 0 for h in fd.hunks):
                raise DiffMaterializeError(
                    f"missing base file for modify: {path}"
                )
            if _is_binary_content(base):
                raise DiffMaterializeError(
                    f"binary file not supported: {path}"
                )

        content = _apply_hunks(base, fd.hunks, path=path)
        entries.append(
            FileEntry(
                path=path,
                size=len(content.encode("utf-8")),
                sha="",
                content=content,
            )
        )

    return entries


__all__ = [
    "DiffMaterializeError",
    "materialize_unified_diff",
]
