"""A restore drill needs something to restore.

Nothing in this repository produced a backup. ``dr_drill.sh`` looked for
``$BACKUP_LOCAL_DIR/eden-*.sql.gz``, found none, wrote
``{"verdict": "FAIL", "reason": "no backup found"}`` and exited 2 — correctly.
Three layers then conspired to hide that:

* ``dr-drill.yml`` had an escape hatch that only fired when *no report existed*.
  But the no-backup path **does** write a report, so the escape was never taken
  and the job exited 2. The DR workflow has been red every Monday since it was
  added — a stuck signal, which is as useless as a stuck-green one.
* ``w29_flag_dr_drills.sh`` captured the drill's exit code and then ``exit 0``
  regardless, so its own report said the drills were "documented".
* ``DR_DRILL_ALLOW_MISSING_BACKUP`` was exported by both, and read by neither.
  Pure decoration implying a soft-fail that did not exist.

Underneath all of it, Eden had no backups at all.

``scripts/backup_postgres.sh`` is the missing half. Verified end to end against a
local Postgres: 500 rows dumped, restored into a scratch database, and identical
at both ends; then again with the tables ``dr_drill.sh`` checks, giving a drill
exit of 0. Its three refusal paths were exercised too — no ``DATABASE_URL``, a
sub-1 KiB dump, and a corrupt gzip all fail loudly and leave no file behind.

Running it end to end also surfaced two pre-existing bugs that made the drill
unrunnable outside Linux CI: ``stat -c %Y`` is GNU-only (macOS needs ``-f %m``),
and ``${BACKUP_S3_BUCKET:-…}`` substituted the production bucket even when the
variable was deliberately empty, so every local run reached for S3 and printed an
AWS credential error.

**Not verified here:** the Neon and S3 code paths. Those need credentials this
repo does not carry, so the first scheduled run is the verification — which is
why the script fails hard on every error instead of warning.
"""

from __future__ import annotations

import re
import stat
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_BACKUP = _ROOT / "scripts" / "backup_postgres.sh"
_DRILL = _ROOT / "scripts" / "dr_drill.sh"
_WRAPPER = _ROOT / "scripts" / "w29_flag_dr_drills.sh"
_WORKFLOW = _ROOT / ".github" / "workflows" / "dr-drill.yml"


class TestABackupProducerExists:
    def test_the_script_is_present(self) -> None:
        assert _BACKUP.exists(), (
            "no backup producer — dr_drill.sh has nothing to restore, so the "
            "drill can only ever report 'no backup found'"
        )

    def test_it_is_executable(self) -> None:
        assert _BACKUP.stat().st_mode & stat.S_IXUSR

    def test_it_writes_the_name_the_drill_looks_for(self) -> None:
        """A mismatched glob means the drill cannot see what was just written."""
        produced = _BACKUP.read_text(encoding="utf-8")
        expected_glob = _DRILL.read_text(encoding="utf-8")
        assert "eden-${TS}.sql.gz" in produced
        assert "eden-*.sql.gz" in expected_glob

    def test_it_refuses_without_a_database_url(self) -> None:
        src = _BACKUP.read_text(encoding="utf-8")
        assert 'if [ -z "${DATABASE_URL:-}" ]' in src
        assert "refusing to claim a backup was taken" in src

    def test_it_rejects_an_implausibly_small_dump(self) -> None:
        """``pg_dump`` against the wrong database 'succeeds' and yields ~400B."""
        src = _BACKUP.read_text(encoding="utf-8")
        assert "-lt 1024" in src
        assert "refusing to pass off an empty backup" in src

    def test_it_verifies_the_gzip_stream(self) -> None:
        assert "gzip -t" in _BACKUP.read_text(encoding="utf-8")

    def test_an_s3_upload_failure_is_fatal(self) -> None:
        """A backup that exists only on an ephemeral runner is not a backup."""
        src = _BACKUP.read_text(encoding="utf-8")
        upload = src[src.index("aws s3 cp") :][:300]
        assert "|| true" not in upload, "an upload failure is being swallowed"
        assert "fail " in upload

    def test_retention_does_not_delete_remote_objects(self) -> None:
        """A bad backup run must not be able to destroy backup history."""
        src = _BACKUP.read_text(encoding="utf-8")
        assert "aws s3 rm" not in src
        assert "aws s3api delete" not in src


class TestNoSoftFail:
    def test_the_dead_flag_is_gone_from_executable_lines(self) -> None:
        """It was exported by two files and read by none."""
        for path in (_WRAPPER, _WORKFLOW, _DRILL):
            for i, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), 1
            ):
                stripped = line.strip()
                if stripped.startswith(("#", "//")):
                    continue  # explanatory comments are fine
                assert "DR_DRILL_ALLOW_MISSING_BACKUP" not in stripped, (
                    f"{path.name}:{i} still sets a flag nothing reads"
                )

    def test_the_wrapper_exit_code_depends_on_the_dr_verdict(self) -> None:
        """It used to ``exit 0`` however the drill went."""
        src = _WRAPPER.read_text(encoding="utf-8")
        assert re.search(r'if \[\[ "\$DR_VERDICT" !=', src), (
            "the wrapper ignores the DR verdict, so a failed drill still "
            "reports the drills as documented"
        )

    def test_the_workflow_does_not_swallow_a_non_zero_exit(self) -> None:
        src = _WORKFLOW.read_text(encoding="utf-8")
        assert "set +e" not in src, "the workflow disables error propagation"
        assert "exit 0" not in src, "the workflow has a soft-fail escape"

    def test_the_workflow_seeds_a_backup_before_drilling(self) -> None:
        """Otherwise the drill's only possible outcome is 'no backup found'.

        Order is read from the parsed step list, not from string offsets: the
        file's header comment mentions ``dr_drill.sh`` before any step runs, so
        an index comparison on the raw text gets the order backwards. (It did.)
        """
        import yaml

        steps = yaml.safe_load(_WORKFLOW.read_text(encoding="utf-8"))["jobs"][
            "dr-drill"
        ]["steps"]
        commands = [s.get("run", "") for s in steps]
        backup_at = next(
            (i for i, c in enumerate(commands) if "backup_postgres.sh" in c), None
        )
        drill_at = next(
            (i for i, c in enumerate(commands) if "dr_drill.sh" in c), None
        )
        assert backup_at is not None, "the workflow never takes a backup"
        assert drill_at is not None, "the workflow never runs the drill"
        assert backup_at < drill_at, (
            "the drill runs before a backup exists, so its only possible "
            "outcome is 'no backup found'"
        )


class TestDrillPortability:
    def test_no_gnu_only_stat(self) -> None:
        """``stat -c`` killed the script on macOS before any restore ran."""
        src = _DRILL.read_text(encoding="utf-8")
        for i, line in enumerate(src.splitlines(), 1):
            if line.strip().startswith("#"):
                continue
            if "stat -c" in line:
                assert "stat -f" in line or "stat -f" in src, (
                    f"dr_drill.sh:{i} uses GNU-only 'stat -c' with no BSD "
                    "fallback, so the drill cannot run on macOS"
                )

    def test_an_empty_bucket_means_local_only(self) -> None:
        """``:-`` substituted the prod bucket even when explicitly emptied."""
        src = _DRILL.read_text(encoding="utf-8")
        assert 'BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET-' in src, (
            "':-' makes an explicitly empty BACKUP_S3_BUCKET fall back to the "
            "production bucket, so a local-only drill is impossible"
        )


class TestScriptsAreValidShell:
    @pytest.mark.parametrize("path", [_BACKUP, _DRILL, _WRAPPER])
    def test_parses(self, path: Path) -> None:
        import subprocess

        result = subprocess.run(
            ["bash", "-n", str(path)], capture_output=True, text=True
        )
        assert result.returncode == 0, f"{path.name}: {result.stderr}"

    @pytest.mark.parametrize("path", [_BACKUP, _DRILL, _WRAPPER])
    def test_uses_strict_mode(self, path: Path) -> None:
        assert "set -euo pipefail" in path.read_text(encoding="utf-8")
