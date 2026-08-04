"""Secret-hygiene guards added after the 2026-08 .env history purge.

Complements ``test_no_tracked_secrets.py``: these assertions pin the exact
file classes that were involved in the 2026-08 incident (a committed
``.env``, a loose GitHub App ``.pem``, a Redis ``dump.rdb``, and ad-hoc
``.tmp-*.py`` scripts) so they can never be tracked again.

They run against ``git ls-files`` (the index), not the working tree —
local untracked copies are fine; committing them is not.
"""

from __future__ import annotations

import fnmatch
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

# Patterns that must never match a tracked path.  fnmatch-style, matched
# against the full repo-relative path and the basename.
FORBIDDEN_TRACKED_PATTERNS: tuple[str, ...] = (
    ".env",
    "*/.env",
    "*.pem",
    "*.rdb",
    ".tmp-*",
    "*/.tmp-*",
    "*.private-key.*",
)

# Exceptions: test fixtures that intentionally look like keys but are inert.
ALLOWED_EXCEPTIONS: tuple[str, ...] = (
    "tests/fixtures/*",
    "*/testdata/*",
)


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.splitlines()


def _is_exception(path: str) -> bool:
    return any(fnmatch.fnmatch(path, pat) for pat in ALLOWED_EXCEPTIONS)


def test_no_forbidden_secret_files_tracked() -> None:
    offenders: list[str] = []
    for path in _tracked_files():
        base = path.rsplit("/", 1)[-1]
        for pat in FORBIDDEN_TRACKED_PATTERNS:
            if fnmatch.fnmatch(path, pat) or fnmatch.fnmatch(base, pat):
                if not _is_exception(path):
                    offenders.append(path)
                break
    assert not offenders, (
        "Credential-bearing or ad-hoc files are tracked by git: "
        f"{offenders}. Remove with `git rm --cached` and keep them in "
        "untracked local config or the deployment secret store. "
        "See docs/ops/credential-rotation-2026-08.md."
    )


def test_gitignore_covers_incident_file_classes() -> None:
    """The classes from the 2026-08 incident must stay ignored.

    Guards against someone 'simplifying' .gitignore and re-exposing the
    exact files that leaked before.
    """
    gitignore = (REPO_ROOT / ".gitignore").read_text()
    required = (".env", "*.pem", "*.rdb")
    missing = [pat for pat in required if pat not in gitignore]
    assert not missing, (
        f".gitignore no longer covers {missing}; restore the patterns "
        "(they prevent a repeat of the 2026-08 committed-.env incident)."
    )
