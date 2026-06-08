"""Eden Agent CLI — entry point.

This is what ``eden`` (the console script) invokes.

Two dispatch modes:

    1. Thin CLI compatibility — when the first argument matches a
       known legacy thin-CLI command (``generate``, ``environment``,
       ``job``, ``benchmark``, ``config``, ``login`` …) we delegate
       to ``eden.cli`` (the legacy Click CLI) for backward compat.
       This matches the Phase 1 / roadmap contract.

    2. TUI launch — for everything else, we launch the Aider-based
       interactive TUI with Eden config, model routing, and the
       EdenCoder registered as ``edit_format = "eden"``.

The two modes are bridged in a single function so the user can
type ``eden chat`` (TUI) and ``eden generate --help`` (legacy) from
the same binary.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Optional, Sequence

from eden import __version__
from eden.config import EdenCLIConfig, load_config, scaffold_config

logger = logging.getLogger("eden.cli")


# ── Legacy thin-CLI delegation ─────────────────────────────────────────
#
# These are the command names that the legacy Click CLI at
# ``src/eden/cli/`` (note: NOT our ``eden`` package) owns. We detect
# them by exact first-argument match and re-exec into the legacy
# entry point. This is the union-friendly contract — when the legacy
# CLI is removed, just delete this block and nothing else needs to
# change.
#
# The list mirrors ``eden-agent-cli-roadmap.md`` § 1.7 (Entry Point
# Routing) and the D2 deprecation list.

_LEGACY_THIN_COMMANDS = frozenset(
    {
        "generate",
        "environment",
        "env",
        "job",
        "benchmark",
        "ci",
        "trace",
        "config",
        "security",
        "review",
        "canary",
    }
)


def _maybe_delegate_to_legacy(argv: Sequence[str]) -> int:
    if not argv:
        return -1  # no argv → TUI
    first = argv[0]
    if first in _LEGACY_THIN_COMMANDS:
        # Re-exec into the legacy CLI's main. We use a subprocess so
        # we never collide with this package's import graph.
        import subprocess

        try:
            return subprocess.call(
                [sys.executable, "-m", "eden.cli", *argv]
            )
        except FileNotFoundError:
            print(
                "Legacy thin CLI is not installed. "
                "If you need it, install the 'eden' package separately.",
                file=sys.stderr,
            )
            return 1
    return -1


# ── TUI launch ────────────────────────────────────────────────────────


def _ensure_config() -> EdenCLIConfig:
    """Load config and scaffold one if none exists.

    The very first run of ``eden`` writes ``~/.eden/config.yaml`` with
    sane defaults and tells the user to fill in ``api_key`` and
    ``org_id``. We do NOT fail on missing auth — the TUI should still
    open so the user can run ``eden login``.
    """
    cfg = load_config()
    global_path = Path.home() / ".eden" / "config.yaml"
    if not global_path.exists():
        scaffold_config(global_path)
        print(
            f"[eden] Wrote starter config to {global_path}.\n"
            "      Set EDEN_API_KEY and EDEN_ORG_ID (or edit the file), "
            "then re-run.",
            file=sys.stderr,
        )
    return cfg


def _launch_tui(cfg: EdenCLIConfig, rest: Sequence[str]) -> int:
    """Launch the Aider-based TUI with Eden wiring.

    Aider is invoked as a library (``aider.coders.main``) when
    available; otherwise we fall back to shelling out to the
    ``aider`` binary, which is a documented public entry point.
    """
    # Lazy import — Aider is heavy. Defer until we know we need it.
    from eden.coders import (
        EdenCoder,
        is_aider_available,
        register_with_aider,
    )

    register_with_aider()

    if not is_aider_available():
        # Degrade gracefully — print a helpful message and let the
        # user install Aider rather than crashing.
        print(
            "[eden] The 'aider-chat' package is required for the TUI.\n"
            "      Install it with:  pip install 'aider-chat>=0.86.0'\n"
            "      Or run legacy thin commands (e.g. `eden generate --help`).",
            file=sys.stderr,
        )
        return 2

    # Build a minimal argv to forward to Aider's main.
    from aider import main as aider_main  # type: ignore[import-not-found]
    import io as _io

    # Translate our config → Aider's CLI flags.
    extra: list[str] = list(rest)
    extra += ["--model", cfg.models.code]
    if cfg.base_url:
        extra += ["--openai-api-base", cfg.base_url]
    # Strip our subcommand if present so Aider gets a clean argv
    if extra and extra[0] == "chat":
        extra = extra[1:]

    # Aider's main() reads sys.argv[1:], so set it up and call.
    saved = sys.argv
    sys.argv = [saved[0], *extra]
    try:
        return aider_main()
    except SystemExit as exc:
        return int(exc.code or 0)
    finally:
        sys.argv = saved


# ── Argument parsing for our top-level commands ───────────────────────


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eden",
        description=(
            "Eden Agent CLI — AI-native agent development (Aider fork).\n"
            "Run `eden chat` to start the interactive TUI, or use a "
            "subcommand."
        ),
    )
    p.add_argument(
        "--version", action="version", version=f"eden {__version__}"
    )
    p.add_argument(
        "--api-key", default=None, help="Eden API key (overrides config)"
    )
    p.add_argument(
        "--org", dest="org_id", default=None, help="Eden org id (overrides config)"
    )
    p.add_argument(
        "--base-url", default=None, help="Eden base URL (overrides config)"
    )
    p.add_argument(
        "--autonomous", action="store_const", const="autonomous",
        dest="autonomy", help="Shortcut for --autonomy=autonomous"
    )
    p.add_argument(
        "--verbose", "-v", action="count", default=0,
        help="Increase log verbosity (repeat for more)"
    )

    sub = p.add_subparsers(dest="cmd")

    # `eden chat` — explicit TUI launch
    chat = sub.add_parser("chat", help="Launch the interactive TUI")
    chat.add_argument(
        "--model", default=None, help="Override the chat model (slot name or full)"
    )

    # `eden login` — set API key + org in global config
    login = sub.add_parser("login", help="Save API key + org to global config")
    login.add_argument("--api-key", required=True)
    login.add_argument("--org", required=True, dest="org_id")
    login.add_argument("--base-url", default=None)

    # `eden config show` — print resolved config
    sub.add_parser("config-show", help="Show resolved Eden CLI config")

    # `eden pattern-mine` — cron entry point
    pm = sub.add_parser("pattern-mine", help="Run the pattern miner once")
    pm.add_argument("--repo", default=".")
    pm.add_argument("--lookback", type=int, default=25)
    pm.add_argument("--org", default=None)
    pm.add_argument("--dry-run", action="store_true")

    # `eden kb query ...` — direct (non-TUI) KB query
    kb = sub.add_parser("kb", help="Query the Eden Knowledge Base")
    kb_sub = kb.add_subparsers(dest="kb_action")
    kbq = kb_sub.add_parser("query")
    kbq.add_argument("text", nargs="+")
    kbq.add_argument("--global", dest="scope_global", action="store_true")
    kbq.add_argument("--tenant", dest="scope_tenant", action="store_true")
    kbq.add_argument("--limit", type=int, default=10)

    return p


# ── Subcommand handlers ───────────────────────────────────────────────


def _handle_login(args: argparse.Namespace) -> int:
    """Persist API key + org to ``~/.eden/config.yaml``."""
    path = Path.home() / ".eden" / "config.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    body: list[str] = []
    if path.exists():
        body.append(path.read_text(encoding="utf-8"))
    body.append(
        f"\n# Updated by `eden login` on {_now()}\n"
        f"eden:\n"
        f"  api_key: {_yaml_str(args.api_key)}\n"
        f"  org_id: {_yaml_str(args.org_id)}\n"
    )
    if args.base_url:
        body.append(f"  base_url: {_yaml_str(args.base_url)}\n")
    path.write_text("".join(body), encoding="utf-8")
    print(f"[eden] Saved credentials to {path}")
    return 0


def _handle_config_show(cfg: EdenCLIConfig) -> int:
    import json

    print(json.dumps(cfg.model_dump(mode="json"), indent=2, default=str))
    return 0


def _handle_kb_query(args: argparse.Namespace, cfg: EdenCLIConfig) -> int:
    import asyncio
    from eden.api_client import eden_client
    from eden.commands.kb import handle_kb_query

    text = " ".join(args.text)
    if args.scope_global:
        scope = "global"
    elif args.scope_tenant:
        scope = "tenant"
    else:
        scope = "all"

    async def _run():
        async with eden_client(cfg) as client:
            from eden.kb_context import KBContextProvider

            provider = KBContextProvider(client, cfg.context)
            if scope == "all":
                res = await provider.get_combined_context(text)
            elif scope == "global":
                res = await provider.get_global_context(text)
            else:
                res = await provider.get_tenant_context(text)
            return res

    res = asyncio.run(_run())
    print(res.text or f"_(no results for {text!r})_")
    return 0


def _handle_pattern_mine(args: argparse.Namespace, cfg: EdenCLIConfig) -> int:
    import asyncio
    from eden.pattern_miner import MinerOptions, run_once

    opts = MinerOptions(
        repo_root=Path(args.repo).resolve(),
        org_id=args.org,
        lookback_commits=args.lookback,
        dry_run=args.dry_run,
        write_global=False,
    )
    report = asyncio.run(run_once(cfg, opts))
    import json as _json

    print(_json.dumps(report, indent=2, default=str))
    return 0


# ── Helpers ───────────────────────────────────────────────────────────


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _yaml_str(s: str) -> str:
    """Quote a value for safe inclusion in a YAML literal block."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _configure_logging(verbosity: int) -> None:
    level = logging.WARNING
    if verbosity == 1:
        level = logging.INFO
    elif verbosity >= 2:
        level = logging.DEBUG
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


# ── main() ────────────────────────────────────────────────────────────


def main(argv: Optional[Sequence[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]

    # Legacy delegation: a known thin-CLI command as the first arg
    # → exec the legacy module. We do this BEFORE argparse so the
    # legacy CLI's own --help works.
    delegated = _maybe_delegate_to_legacy(argv)
    if delegated != -1:
        return delegated

    parser = _build_parser()
    try:
        args = parser.parse_args(list(argv))
    except SystemExit as exc:
        # argparse raised SystemExit (bad args or --help). The test
        # suite and any wrapper expecting a return code should see a
        # graceful integer, not a propagated SystemExit.
        return int(exc.code) if isinstance(exc.code, int) else 2
    _configure_logging(args.verbose)

    cfg = load_config(
        api_key=args.api_key,
        base_url=args.base_url,
        org_id=args.org_id,
        autonomy=args.autonomy,
    )

    if args.cmd is None:
        # No subcommand → TUI launch
        return _launch_tui(cfg, argv)

    if args.cmd == "chat":
        return _launch_tui(cfg, argv)

    if args.cmd == "login":
        return _handle_login(args)

    if args.cmd == "config-show":
        return _handle_config_show(cfg)

    if args.cmd == "pattern-mine":
        return _handle_pattern_mine(args, cfg)

    if args.cmd == "kb":
        if getattr(args, "kb_action", None) == "query":
            return _handle_kb_query(args, cfg)
        parser.parse_args(["kb", "--help"])
        return 1

    parser.print_help()
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
