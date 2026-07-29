"""No credential-bearing file may be tracked by git.

``.env`` was tracked for months despite ``.gitignore`` listing it — adding a
path to ``.gitignore`` does nothing for a file git already knows about. It
carried a MiniMax key, an S3 access/secret pair, a Typesense admin key,
``JWT_SECRET`` and ``ENCRYPTION_KEY``. HEAD was later scrubbed to placeholders,
but the values remain in history, and while the file stayed tracked every
future edit risked re-committing live values.

These tests are the standing guard. They shell out to ``git ls-files`` rather
than walking the filesystem, because the property that matters is what git
*tracks*, not what exists on disk.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]

#: Credential shapes worth failing a commit over. Deliberately narrow — a
#: noisy guard gets disabled, and a disabled guard protects nothing.
#:
#: The patterns are written to exclude *known-synthetic* values rather than
#: allow-listing whole files. Blanket-excluding, say, the PII-masker tests
#: would blind the guard to a real key pasted into them later; excluding the
#: specific published example value keeps it live on every line of that file.
_SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    # AWS publishes AKIAIOSFODNN7EXAMPLE in its own docs; it is not a secret
    # and appears in PII-masking fixtures by design.
    (
        "AWS access key id",
        re.compile(r"\bAKIA(?!IOSFODNN7EXAMPLE\b)[0-9A-Z]{16}\b"),
    ),
    # A real PEM body is hundreds of base64 chars. Fixtures use a placeholder
    # body (often one character), so require a plausible payload before
    # calling it a leak.
    (
        "private key block",
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\\n]*[A-Za-z0-9+/=\s\\n]{100,}"
        ),
    ),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("Anthropic key", re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{20,}\b")),
    ("Slack bot token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b")),
)

#: Files that legitimately contain credential-*shaped* text: the template and
#: this guard's own pattern table.
_ALLOWED = {
    ".env.example",
    "tests/security/test_no_tracked_secrets.py",
}


def _tracked_files() -> list[str]:
    out = subprocess.run(
        ["git", "ls-files"],
        cwd=_REPO,
        capture_output=True,
        text=True,
        check=True,
    )
    return [line for line in out.stdout.splitlines() if line.strip()]


def test_dotenv_is_not_tracked() -> None:
    """``.env`` must never be tracked, however gitignored it is."""
    tracked = _tracked_files()
    assert ".env" not in tracked, (
        ".env is tracked by git. .gitignore does not untrack an already-tracked "
        "file — run `git rm --cached .env`."
    )


def test_dotenv_example_is_still_tracked() -> None:
    """The template must survive.

    ``.gitignore`` matches ``.env.*``, so once untracked ``.env.example`` could
    only be restored with ``git add -f``. Losing it silently would be easy.
    """
    assert ".env.example" in _tracked_files()


def test_no_environment_files_tracked() -> None:
    """Catch siblings like ``.env.production`` / ``.env.local``."""
    offenders = [
        f
        for f in _tracked_files()
        if f == ".env" or (f.startswith(".env.") and f != ".env.example")
    ]
    assert not offenders, f"environment files are tracked: {offenders}"


@pytest.mark.parametrize(("label", "pattern"), _SECRET_PATTERNS, ids=lambda v: v if isinstance(v, str) else "")
def test_no_credential_shaped_strings_in_tracked_files(
    label: str, pattern: re.Pattern[str]
) -> None:
    """Scan tracked text files for live-credential shapes."""
    offenders: list[str] = []
    for rel in _tracked_files():
        if rel in _ALLOWED:
            continue
        path = _REPO / rel
        if not path.is_file():
            continue
        # Skip anything large or binary rather than guessing at encodings.
        try:
            if path.stat().st_size > 2_000_000:
                continue
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        if pattern.search(text):
            offenders.append(rel)

    assert not offenders, (
        f"{label} found in tracked files: {offenders}. "
        "Move the value to an untracked .env and reference it via settings."
    )
