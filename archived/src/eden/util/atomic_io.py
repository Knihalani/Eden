"""Crash-safe file replacement.

``open(path, "w")`` truncates the file the instant it is called, before a
single byte of the replacement is written. For a read-modify-write over a
whole-file store that is a data-loss window: the old contents are gone and the
new contents do not exist yet. A process death, a full disk, or a serialization
error inside the write loop leaves the file empty or half-written, and a
concurrent reader sees the truncated state.

The fix is the standard write-temp-then-rename dance. ``os.replace`` is atomic
on POSIX and on Windows, so a reader sees either the whole old file or the
whole new one and never an intermediate state. Two details are easy to get
wrong and both are handled here:

* **The temp file must live in the target's own directory.** ``os.replace``
  across filesystems raises ``OSError``, and the obvious ``tempfile.mkstemp()``
  lands in ``/tmp``, which on most container images is a different mount than
  the data volume.
* **The data must reach disk before the rename.** Without the ``fsync``, a
  power loss can order the metadata change ahead of the data and leave a
  perfectly intact directory entry pointing at a zero-length file — the exact
  outcome the atomic rename was supposed to prevent.

This does not provide mutual exclusion. Two concurrent writers each produce a
complete file and the last rename wins, so a read-modify-write cycle can still
lose the earlier writer's update. That is a different problem (it needs a lock
or a compare-and-swap) and callers that need it must say so; what this module
guarantees is that no reader ever observes a partial file and no crash ever
destroys the previous version.
"""

from __future__ import annotations

import contextlib
import os
import tempfile
from collections.abc import Iterable

__all__ = ["atomic_write_lines", "atomic_write_text"]


def _preserved_mode(path: str) -> int | None:
    """The existing file's permission bits, if it exists.

    ``mkstemp`` creates its file 0600. Renaming that over an existing file
    would silently tighten the permissions, so an existing mode is carried
    across; a genuinely new file keeps the restrictive default.
    """
    try:
        return os.stat(path).st_mode & 0o777
    except OSError:
        return None


def atomic_write_text(path: str, data: str, *, encoding: str = "utf-8") -> None:
    """Replace ``path`` with ``data``, atomically and durably.

    Raises whatever the underlying write raises (``OSError`` on a full disk,
    ``UnicodeEncodeError`` on unencodable text). The temp file is removed on
    any failure and ``path`` is left holding its previous contents.
    """
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    mode = _preserved_mode(path)

    fd, tmp = tempfile.mkstemp(
        dir=directory, prefix=f".{os.path.basename(path)}.", suffix=".tmp"
    )
    try:
        with os.fdopen(fd, "w", encoding=encoding) as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        # Leave no debris and leave ``path`` untouched. ``BaseException`` so a
        # cancellation or KeyboardInterrupt mid-write cleans up too.
        with contextlib.suppress(OSError):
            os.unlink(tmp)
        raise

    # Make the rename itself durable. Without this the directory entry can
    # still be lost to a crash even though the file's data was synced.
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return  # Not all platforms allow opening a directory; the data is synced.
    try:
        os.fsync(dir_fd)
    except OSError:
        pass
    finally:
        os.close(dir_fd)


def atomic_write_lines(
    path: str, lines: Iterable[str], *, encoding: str = "utf-8"
) -> None:
    """``atomic_write_text`` for an iterable of already-newline-terminated lines.

    Mirrors ``fh.writelines`` — no separator is inserted — so a JSONL rewrite
    can swap one call for the other without touching the line construction.
    """
    atomic_write_text(path, "".join(lines), encoding=encoding)
