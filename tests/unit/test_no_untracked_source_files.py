"""Every source file the image needs must actually be in git.

On 2026-07-30 the API crash-looped on every new container:

    ModuleNotFoundError: No module named 'eden.api.responses'
      File "/app/src/eden/api/app.py", line 25, in <module>
        from eden.api.responses import EdenJSONResponse

``responses.py`` existed on disk and had never been ``git add``-ed. The
Docker image builds from the repository, so the module was simply
absent, uvicorn died at import, and Northflank kept serving the last
container that worked. Deploys appeared to "never finish" for hours.

It was twelve files, eight of them imported by committed code —
``eden.util.stable_hash`` alone by eleven. Plus four Alembic revisions
that had already run against the production database while existing
nowhere in version control.

**Why nothing caught it.** That day's checks — 7317 tests, ruff, mypy,
a settings-drift gate, and a full production-mode lifespan boot against
the real database — all ran against the *working tree*, where every one
of those files was present. None ran against what git would ship. A
green suite and a broken image are perfectly compatible when the
difference is untracked files, and no amount of additional local
testing would ever have closed that gap.

This test is deliberately about git state rather than imports: an
untracked file that nothing imports *yet* is the same landmine one
commit later.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]

#: Directories whose contents ship inside the image.
_SHIPPED = ("src/", "migrations/", "supplementaries/")


def _untracked() -> list[str]:
    """Files git does not know about, honouring .gitignore."""
    out = subprocess.run(
        ["git", "ls-files", "--others", "--exclude-standard"],
        cwd=_REPO,
        capture_output=True,
        text=True,
        check=False,
    )
    if out.returncode != 0:
        pytest.skip(f"git unavailable: {out.stderr.strip()[:120]}")
    return [ln.strip() for ln in out.stdout.splitlines() if ln.strip()]


class TestNoUntrackedShippedSources:
    def test_no_untracked_python_under_shipped_dirs(self):
        offenders = [
            f
            for f in _untracked()
            if f.endswith(".py") and f.startswith(_SHIPPED)
        ]
        assert not offenders, (
            "these Python files ship inside the image but are NOT in git, "
            "so the built image will not contain them:\n  "
            + "\n  ".join(offenders)
            + "\n\nThe container fails at import with ModuleNotFoundError "
            "while every local check still passes, because local checks "
            "run against the working tree. `git add` them."
        )

    def test_no_untracked_sql_migrations(self):
        """A migration missing from git cannot be reproduced anywhere.

        Production's alembic_version pointed at a revision that existed
        only on one laptop — so no fresh environment could rebuild the
        schema, and no reviewer could see what had run.
        """
        offenders = [
            f
            for f in _untracked()
            if f.endswith(".sql") and f.startswith(_SHIPPED)
        ]
        assert not offenders, (
            "untracked migration file(s) — these may already have run "
            f"against a real database:\n  " + "\n  ".join(offenders)
        )
