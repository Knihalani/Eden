"""N23 closed-loop: materialize unified diff → LocalPRProvider draft PR.

Replaces the deleted ``eden.code_change`` Cat 23 sandbox flow. Exercises
diff_materializer + LocalPRProvider so committed content is patched source,
not hunk text. Does not require live GitHub.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

import pytest

from eden.patches.diff_materializer import materialize_unified_diff
from eden.providers.pr import LocalPRProvider, PRCreateRequest

GIT = "/usr/bin/git"


def _run_git(*args: str, cwd: Path) -> str:
    result = subprocess.run(
        [GIT, *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


@pytest.fixture
def temp_git_repo() -> Path:
    with tempfile.TemporaryDirectory() as tmp:
        repo = Path(tmp)
        _run_git("init", "-q", "--initial-branch=main", cwd=repo)
        _run_git("config", "user.email", "test@eden.local", cwd=repo)
        _run_git("config", "user.name", "Eden Test", cwd=repo)
        sample = repo / "sample.py"
        sample.write_text("def rate_limit():\n    return 42\n")
        _run_git("add", "sample.py", cwd=repo)
        _run_git("commit", "-q", "-m", "initial", cwd=repo)
        yield repo


@pytest.mark.asyncio
async def test_n23_materialize_local_pr_content_correct(temp_git_repo: Path) -> None:
    synthetic_diff = (
        "--- a/sample.py\n+++ b/sample.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def rate_limit():\n"
        "-    return 42\n"
        "+    return 100  # patched\n"
    )

    async def read_file(path: str) -> str | None:
        target = temp_git_repo / path
        if not target.is_file():
            return None
        return target.read_text()

    files = await materialize_unified_diff(synthetic_diff, read_file=read_file)
    assert len(files) == 1
    assert files[0].path == "sample.py"
    assert files[0].content == "def rate_limit():\n    return 100  # patched\n"
    assert "@@" not in files[0].content
    assert "-    return 42" not in files[0].content

    provider = LocalPRProvider(repo_path=str(temp_git_repo))
    info = await provider.create_pr(
        PRCreateRequest(
            title="[Eden] Fix rate_limit",
            body="N23 materialize → LocalPRProvider",
            branch="eden/n23-loop",
            base="main",
            draft=True,
            files=files,
        )
    )
    assert info.branch == "eden/n23-loop"
    assert info.number >= 0
    assert "return 100" in (temp_git_repo / "sample.py").read_text()
