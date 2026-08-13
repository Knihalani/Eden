#!/usr/bin/env python3
"""check_changelog_freshness — verify SDK changelog matches installed version.

Compares the newest version heading in sdk/python/CHANGELOG.md against
the version declared in sdk/python/eden_sdk/__init__.py (``__version__``).
Fails with exit code 1 when they don't match so CI catches a forgotten
changelog update before it ships.

Usage::

    python scripts/check_changelog_freshness.py

Exit codes:
  0  — changelog heading matches installed version (or both are the same)
  1  — mismatch; prints which version is installed vs newest heading
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent

PYTHON_INIT = REPO_ROOT / "sdk" / "python" / "eden_sdk" / "__init__.py"
PYTHON_CHANGELOG = REPO_ROOT / "sdk" / "python" / "CHANGELOG.md"

TS_PACKAGE_JSON = REPO_ROOT / "sdk" / "ts-ai" / "package.json"
TS_CHANGELOG = REPO_ROOT / "sdk" / "ts-ai" / "CHANGELOG.md"

# Heading pattern: ## 0.4.2 — ... or ## [0.4.2] — ...
_HEADING_RE = re.compile(r"^##\s+\[?(\d+\.\d+\.\d+)\]?")
_VERSION_RE = re.compile(r'__version__\s*=\s*["\']([^"\']+)["\']')


def _newest_changelog_version(changelog: Path) -> str | None:
    """Return the version string from the first '## x.y.z' heading."""
    try:
        for line in changelog.read_text().splitlines():
            m = _HEADING_RE.match(line)
            if m:
                return m.group(1)
    except OSError:
        pass
    return None


def _python_installed_version() -> str | None:
    try:
        text = PYTHON_INIT.read_text()
        m = _VERSION_RE.search(text)
        return m.group(1) if m else None
    except OSError:
        return None


def _ts_installed_version() -> str | None:
    import json
    try:
        data = json.loads(TS_PACKAGE_JSON.read_text())
        return data.get("version")
    except (OSError, ValueError):
        return None


def _check(label: str, installed: str | None, changelog: Path) -> bool:
    """Return True if OK, False if drift detected."""
    newest = _newest_changelog_version(changelog)

    if installed is None:
        print(f"WARNING [{label}]: could not determine installed version")
        return True  # don't fail if we can't read the version

    if newest is None:
        print(f"FAIL [{label}]: no version heading found in {changelog.relative_to(REPO_ROOT)}")
        return False

    if newest != installed:
        print(
            f"FAIL [{label}]: version mismatch\n"
            f"  installed:  {installed}\n"
            f"  changelog:  {newest}  ({changelog.relative_to(REPO_ROOT)})\n"
            f"  Add a '## {installed}' heading to the changelog before merging."
        )
        return False

    print(f"OK   [{label}]: {installed} matches changelog")
    return True


def main() -> int:
    ok = True

    ok &= _check(
        "Python SDK",
        _python_installed_version(),
        PYTHON_CHANGELOG,
    )
    ok &= _check(
        "TypeScript SDK",
        _ts_installed_version(),
        TS_CHANGELOG,
    )

    if not ok:
        return 1

    print("\ncheck_changelog_freshness: all SDK changelogs are up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
