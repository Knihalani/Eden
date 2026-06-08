"""Pattern miner — cron entry point that feeds the tenant KB.

The pattern miner observes the codebase in the current working
directory over time and writes team-specific conventions back to the
Eden tenant KB. It is meant to be run on a schedule (e.g. nightly
via cron / k8s CronJob / GitHub Actions schedule).

Two strategies are implemented in this build:

    1. ``scan_codebase`` — extracts simple, deterministic patterns
       (function signatures, public API surface, docstring tone) and
       writes a single consolidated KB entry per run.

    2. ``scan_recent_changes`` — looks at git history in the cwd
       and writes a "recent change themes" entry summarising the
       last N commits.

Both are intentionally simple: the goal is a working cron entry
point that ships something useful, not an LLM-heavy analysis loop.
A future iteration can swap the body of these functions for a
real LLM call (the same ``IMPROVE_LLM_CALL`` hook used by
``/eden-improve``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from eden.api_client import EdenAPIError, eden_client
from eden.config import EdenCLIConfig

logger = logging.getLogger("eden.cli.pattern_miner")


# ── Public config knobs (CLI flags) ─────────────────────────────────────


@dataclass
class MinerOptions:
    repo_root: Path
    org_id: Optional[str]
    lookback_commits: int = 25
    write_global: bool = False  # whether to also write to global KB
    dry_run: bool = False


# ── Codebase scan ───────────────────────────────────────────────────────


@dataclass
class CodebaseScanResult:
    python_files: int = 0
    ts_files: int = 0
    public_functions: int = 0
    public_classes: int = 0
    module_docstring_present: bool = False
    top_level_imports: list[str] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.top_level_imports is None:
            self.top_level_imports = []


def scan_codebase(root: Path) -> CodebaseScanResult:
    """Walk the codebase, extract simple structural patterns.

    Skips the usual noise directories. Caps at 5000 files to keep
    the miner cheap on a cron.
    """
    SKIP = {
        ".git", "node_modules", "__pycache__", ".venv", "venv",
        "dist", "build", ".next", "target", ".mypy_cache", ".claude",
    }
    py_files: list[Path] = []
    ts_files: list[Path] = []
    public_funcs = 0
    public_classes = 0
    module_doc = False
    imports: set[str] = set()
    seen = 0

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP and not d.startswith(".")]
        for fn in filenames:
            if seen > 5000:
                break
            p = Path(dirpath) / fn
            if p.suffix == ".py":
                py_files.append(p)
            elif p.suffix in (".ts", ".tsx"):
                ts_files.append(p)
            seen += 1

    for p in py_files[:500]:
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines()[:200]:  # cheap, file-level scan
            stripped = line.strip()
            if stripped.startswith("def ") and not stripped.startswith("def _"):
                public_funcs += 1
            elif stripped.startswith("class ") and not stripped.startswith("class _"):
                public_classes += 1
            elif stripped.startswith('"""') and len(stripped) > 4:
                module_doc = True
            elif stripped.startswith("import ") or stripped.startswith("from "):
                # Only top-level package names
                tok = stripped.split()[1].split(".")[0]
                if tok and not tok.startswith("."):
                    imports.add(tok)

    return CodebaseScanResult(
        python_files=len(py_files),
        ts_files=len(ts_files),
        public_functions=public_funcs,
        public_classes=public_classes,
        module_docstring_present=module_doc,
        top_level_imports=sorted(imports)[:25],
    )


# ── Git history scan ────────────────────────────────────────────────────


def scan_recent_changes(root: Path, *, n: int) -> list[dict[str, str]]:
    """Return up to ``n`` recent commits as ``{sha, subject, author, ts}``.

    Empty list when no git repo is present.
    """
    try:
        proc = subprocess.run(
            [
                "git", "-C", str(root), "log",
                f"-n{n}",
                "--pretty=format:%H%x1f%s%x1f%an%x1f%ad",
                "--date=iso",
            ],
            capture_output=True, text=True, timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        logger.warning("git log failed: %s", exc)
        return []
    if proc.returncode != 0:
        return []
    out: list[dict[str, str]] = []
    for line in proc.stdout.splitlines():
        parts = line.split("\x1f", 4)
        if len(parts) != 4:
            continue
        sha, subject, author, ts = parts
        out.append(
            {"sha": sha[:12], "subject": subject[:120], "author": author, "ts": ts}
        )
    return out


# ── KB write helpers ────────────────────────────────────────────────────


def _build_entry(
    *,
    title: str,
    body: str,
    tags: list[str],
    source: str,
) -> dict[str, Any]:
    return {
        "title": title,
        "body": body,
        "tags": tags,
        "source": source,
        "kind": "pattern_miner",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


async def write_entry(
    cfg: EdenCLIConfig,
    entry: dict[str, Any],
    *,
    org_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    try:
        async with eden_client(cfg) as client:
            return await client.write_kb_entry(entry, org_id=org_id)
    except EdenAPIError as exc:
        logger.warning("KB write failed: %s", exc)
        return None


# ── Top-level cron entry point ──────────────────────────────────────────


async def run_once(cfg: EdenCLIConfig, opts: MinerOptions) -> dict[str, Any]:
    """Run one mining pass and write findings to the tenant KB.

    Returns a small report dict suitable for logging / cron stdout.
    """
    cb = scan_codebase(opts.repo_root)
    commits = scan_recent_changes(opts.repo_root, n=opts.lookback_commits)

    # Codebase summary entry
    cb_entry = _build_entry(
        title=f"Codebase snapshot: {opts.repo_root.name} ({datetime.now(timezone.utc).date()})",
        body=json.dumps(
            {
                "python_files": cb.python_files,
                "ts_files": cb.ts_files,
                "public_functions": cb.public_functions,
                "public_classes": cb.public_classes,
                "module_docstring_present": cb.module_docstring_present,
                "top_level_imports": cb.top_level_imports,
            },
            indent=2,
        ),
        tags=["codebase", "snapshot", "auto-mined"],
        source=f"pattern_miner:{opts.repo_root.name}",
    )

    # Recent changes entry
    rc_entry = _build_entry(
        title=f"Recent change themes: {opts.repo_root.name}",
        body="\n".join(
            f"- `{c['sha']}` {c['subject']} _({c['author']}, {c['ts']})_"
            for c in commits
        ) or "_(no commits in window)_",
        tags=["changelog", "auto-mined"],
        source=f"pattern_miner:{opts.repo_root.name}",
    )

    report: dict[str, Any] = {
        "codebase": cb.__dict__,
        "commits": len(commits),
        "wrote_entries": [],
        "dry_run": opts.dry_run,
    }

    if opts.dry_run:
        report["would_write"] = [cb_entry["title"], rc_entry["title"]]
        return report

    org = opts.org_id or cfg.org_id
    for entry in (cb_entry, rc_entry):
        resp = await write_entry(cfg, entry, org_id=org)
        if resp is not None:
            report["wrote_entries"].append(entry["title"])

    return report


def main(argv: Optional[list[str]] = None) -> int:
    """CLI entry: ``eden-pattern-miner`` (called by cron)."""
    import argparse

    parser = argparse.ArgumentParser(prog="eden-pattern-miner")
    parser.add_argument("--repo", default=".", help="Repo root to mine")
    parser.add_argument("--org", default=None, help="Org id (overrides config)")
    parser.add_argument("--lookback", type=int, default=25)
    parser.add_argument("--global", dest="write_global", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--config", default=None, help="Explicit config file path")
    args = parser.parse_args(argv)

    if args.config:
        # Allow CI/cron to point at a specific config; loaded as both
        # global and project yaml locations to keep precedence simple.
        os.environ.setdefault("EDEN_CONFIG_FILE", args.config)

    cfg = EdenCLIConfig()  # uses defaults; full resolver lives in eden.config
    repo = Path(args.repo).resolve()
    opts = MinerOptions(
        repo_root=repo,
        org_id=args.org,
        lookback_commits=args.lookback,
        write_global=args.write_global,
        dry_run=args.dry_run,
    )

    report = asyncio.run(run_once(cfg, opts))
    print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
