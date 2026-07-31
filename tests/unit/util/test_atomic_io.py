"""A failed whole-file rewrite must not destroy the previous file.

``PRSuggester`` kept its suggestions in a JSONL file and updated a row by
reading the file, editing one line in memory, and writing the whole thing back
with ``open(path, "w")``. That call truncates on entry, so between the truncate
and the last ``writelines`` byte the store held nothing. A crash, a full disk,
or a serialization error in the middle lost every suggestion for every org --
and the write was wrapped in ``except Exception: logger.debug(...)``, so the
caller went on to mark the row "opened" in Postgres and return success to the
API while the file on disk still said "pending".

These tests pin the two properties that fix it: the replacement is atomic (a
failure leaves the old contents intact) and a failure is not swallowed.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from eden.util.atomic_io import atomic_write_lines, atomic_write_text


class TestAtomicity:
    def test_replaces_contents(self, tmp_path: Path) -> None:
        target = tmp_path / "store.jsonl"
        target.write_text("old\n", encoding="utf-8")
        atomic_write_text(str(target), "new\n")
        assert target.read_text(encoding="utf-8") == "new\n"

    def test_creates_a_missing_file(self, tmp_path: Path) -> None:
        target = tmp_path / "fresh.jsonl"
        atomic_write_text(str(target), "hello\n")
        assert target.read_text(encoding="utf-8") == "hello\n"

    def test_creates_missing_parent_directories(self, tmp_path: Path) -> None:
        target = tmp_path / "nested" / "deeper" / "store.jsonl"
        atomic_write_text(str(target), "x\n")
        assert target.read_text(encoding="utf-8") == "x\n"

    def test_a_failed_write_leaves_the_old_file_intact(self, tmp_path: Path) -> None:
        """The whole point: no truncation window."""
        target = tmp_path / "store.jsonl"
        target.write_text("row-1\nrow-2\n", encoding="utf-8")

        boom = OSError(28, "No space left on device")
        with patch("os.fsync", side_effect=boom), pytest.raises(OSError):
            atomic_write_text(str(target), "replacement\n")

        assert target.read_text(encoding="utf-8") == "row-1\nrow-2\n", (
            "a failed atomic write clobbered the previous contents"
        )

    def test_a_failed_write_leaves_no_temp_file_behind(self, tmp_path: Path) -> None:
        target = tmp_path / "store.jsonl"
        target.write_text("keep\n", encoding="utf-8")

        with patch("os.fsync", side_effect=OSError("nope")), pytest.raises(OSError):
            atomic_write_text(str(target), "x\n")

        assert [p.name for p in tmp_path.iterdir()] == ["store.jsonl"]

    def test_a_failed_write_propagates_rather_than_returning(
        self, tmp_path: Path
    ) -> None:
        target = tmp_path / "store.jsonl"
        with patch("os.replace", side_effect=OSError("EXDEV")):
            with pytest.raises(OSError):
                atomic_write_text(str(target), "x\n")

    def test_cancellation_mid_write_still_cleans_up(self, tmp_path: Path) -> None:
        """``BaseException``, not ``Exception`` -- a cancelled task must not leak."""
        target = tmp_path / "store.jsonl"
        target.write_text("keep\n", encoding="utf-8")

        with patch("os.fsync", side_effect=KeyboardInterrupt):
            with pytest.raises(KeyboardInterrupt):
                atomic_write_text(str(target), "x\n")

        assert [p.name for p in tmp_path.iterdir()] == ["store.jsonl"]
        assert target.read_text(encoding="utf-8") == "keep\n"


class TestTempFilePlacement:
    def test_temp_file_is_created_in_the_target_directory(
        self, tmp_path: Path
    ) -> None:
        """A temp in /tmp would make ``os.replace`` fail across mounts.

        Containers routinely mount the data volume separately from ``/tmp``, so
        a ``tempfile.mkstemp()`` with no ``dir=`` produces an
        ``OSError: [Errno 18] Invalid cross-device link`` in production and
        never in a test where both live under the same filesystem. Assert the
        directory explicitly rather than relying on the rename succeeding.
        """
        target = tmp_path / "sub" / "store.jsonl"
        target.parent.mkdir()

        with patch("tempfile.mkstemp", wraps=tempfile.mkstemp) as spy:
            atomic_write_text(str(target), "x\n")

        assert spy.call_args is not None
        assert spy.call_args.kwargs["dir"] == str(target.parent)


class TestPermissions:
    def test_existing_mode_is_preserved(self, tmp_path: Path) -> None:
        """mkstemp creates 0600; renaming it over a file must not tighten it."""
        target = tmp_path / "store.jsonl"
        target.write_text("old\n", encoding="utf-8")
        os.chmod(target, 0o644)
        atomic_write_text(str(target), "new\n")
        assert os.stat(target).st_mode & 0o777 == 0o644

    def test_new_file_keeps_the_restrictive_default(self, tmp_path: Path) -> None:
        target = tmp_path / "fresh.jsonl"
        atomic_write_text(str(target), "x\n")
        assert os.stat(target).st_mode & 0o777 == 0o600


class TestWriteLines:
    def test_joins_without_inserting_separators(self, tmp_path: Path) -> None:
        """Must match ``fh.writelines`` so JSONL callers can swap one for the other."""
        target = tmp_path / "store.jsonl"
        atomic_write_lines(str(target), ['{"a":1}\n', '{"b":2}\n'])
        assert target.read_text(encoding="utf-8") == '{"a":1}\n{"b":2}\n'

    def test_accepts_a_generator(self, tmp_path: Path) -> None:
        target = tmp_path / "store.jsonl"
        atomic_write_lines(str(target), (f"{i}\n" for i in range(3)))
        assert target.read_text(encoding="utf-8") == "0\n1\n2\n"

    def test_empty_iterable_produces_an_empty_file(self, tmp_path: Path) -> None:
        target = tmp_path / "store.jsonl"
        target.write_text("old\n", encoding="utf-8")
        atomic_write_lines(str(target), [])
        assert target.read_text(encoding="utf-8") == ""


class TestDurability:
    def test_data_is_synced_before_the_rename(self, tmp_path: Path) -> None:
        """Otherwise a crash can leave an intact name over a zero-length file."""
        order: list[str] = []
        target = tmp_path / "store.jsonl"
        real_fsync, real_replace = os.fsync, os.replace

        def _fsync(fd: int) -> None:
            order.append("fsync")
            real_fsync(fd)

        def _replace(a: str, b: str) -> None:
            order.append("replace")
            real_replace(a, b)

        with patch("os.fsync", _fsync), patch("os.replace", _replace):
            atomic_write_text(str(target), "x\n")

        assert order.index("fsync") < order.index("replace")

    def test_directory_is_synced_after_the_rename(self, tmp_path: Path) -> None:
        order: list[str] = []
        target = tmp_path / "store.jsonl"
        real_fsync, real_replace = os.fsync, os.replace

        def _fsync(fd: int) -> None:
            order.append("fsync")
            real_fsync(fd)

        def _replace(a: str, b: str) -> None:
            order.append("replace")
            real_replace(a, b)

        with patch("os.fsync", _fsync), patch("os.replace", _replace):
            atomic_write_text(str(target), "x\n")

        # One fsync for the data, the rename, then one for the directory entry.
        assert order == ["fsync", "replace", "fsync"]

    def test_an_unopenable_directory_does_not_fail_the_write(
        self, tmp_path: Path
    ) -> None:
        """The data is already synced; a platform that refuses O_RDONLY on a
        directory must not turn a successful write into an error."""
        target = tmp_path / "store.jsonl"
        real_open = os.open

        def _open(path: str, flags: int, *a: object, **k: object) -> int:
            if path == str(tmp_path):
                raise OSError("directories not openable here")
            return real_open(path, flags, *a, **k)  # type: ignore[arg-type]

        with patch("os.open", _open):
            atomic_write_text(str(target), "x\n")
        assert target.read_text(encoding="utf-8") == "x\n"
