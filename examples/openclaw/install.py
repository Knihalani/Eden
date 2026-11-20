#!/usr/bin/env python3
"""Install the Eden plugin for OpenClaw: `<openclaw-home>/extensions/eden/` + `bin/eden-local`.

Run inside an Eden release archive (which ships `index.js` and `bin/eden-local`) or a repo checkout
(where this builds both with Bun). `--openclaw-home PATH` installs somewhere other than `~/.openclaw`.
When the `openclaw` CLI is on PATH this also runs `plugins enable`; the conversation-access grant in
`<openclaw-home>/openclaw.json` is merged or printed when the file is absent.
"""

import argparse
import json
import os
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GRANT = {
    "plugins": {
        "entries": {"eden": {"enabled": True, "hooks": {"allowConversationAccess": True}}}
    }
}


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def claw_home(args):
    if args.openclaw_home:
        return Path(os.path.expandvars(args.openclaw_home)).expanduser().resolve()
    return Path(os.environ.get("OPENCLAW_HOME", Path.home() / ".openclaw")).expanduser().resolve()


def ensure_bundle(root, work):
    prebuilt = HERE / "index.js"
    if prebuilt.is_file():
        return prebuilt
    bun = shutil.which("bun")
    if not root or not bun:
        sys.exit("Need Bun and a repo checkout, or a release archive containing index.js")
    out = work / "index.js"
    subprocess.run(
        [bun, "build", "--target=node", f"--outfile={out}", "examples/openclaw/eden.ts"],
        cwd=root,
        check=True,
    )
    return out


def ensure_binary(root, work):
    prebuilt = HERE / "bin" / "eden-local"
    if prebuilt.is_file():
        return prebuilt
    bun = shutil.which("bun")
    if not root or not bun:
        sys.exit("Need Bun and a repo checkout, or a release archive containing bin/eden-local")
    out = work / "eden-local"
    subprocess.run(
        [
            bun,
            "build",
            "--compile",
            "--no-compile-autoload-dotenv",
            "--no-compile-autoload-bunfig",
            f"--outfile={out}",
            "packages/server/src/main.ts",
        ],
        cwd=root,
        check=True,
    )
    return out


def merge_grant(config_path):
    if not config_path.is_file():
        return False
    try:
        config = json.loads(config_path.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    entries = config.setdefault("plugins", {}).setdefault("entries", {})
    entry = entries.setdefault("eden", {})
    entry["enabled"] = True
    entry.setdefault("hooks", {})["allowConversationAccess"] = True
    config_path.write_text(json.dumps(config, indent=2) + "\n")
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--openclaw-home",
        metavar="PATH",
        help="OpenClaw home directory (default: $OPENCLAW_HOME or ~/.openclaw)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(tempfile.mkdtemp(prefix="eden-openclaw-install-"))
    try:
        bundle = ensure_bundle(root, work)
        binary = ensure_binary(root, work)

        home = claw_home(args)
        dest = home / "extensions" / "eden"
        (dest / "bin").mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundle, dest / "index.js")
        for name in ("openclaw.plugin.json", "package.json"):
            src = HERE / name
            if src.is_file():
                shutil.copy2(src, dest / name)
        # Rename staged in the same directory: copy2 over a still-running detached server fails
        # ETXTBSY on Linux, and a cross-filesystem rename fails EXDEV.
        bin_out = dest / "bin" / "eden-local"
        staged = dest / "bin" / f".eden-local.{os.getpid()}.tmp"
        shutil.copy2(binary, staged)
        staged.chmod(0o755)
        os.replace(staged, bin_out)

        claw = shutil.which("openclaw")
        if claw:
            subprocess.run([claw, "plugins", "enable", "eden"], check=False)

        config_path = home / "openclaw.json"
        merged = merge_grant(config_path)
        print(f"Installed Eden to {dest}")
        print(
            "- Conversation access granted in openclaw.json"
            if merged
            else f"- Add the conversation grant to {config_path}:\n{json.dumps(GRANT, indent=2)}"
        )
        print("- Restart the gateway or run `openclaw plugins reload`.")
        print("- Sources: write ~/.openclaw/eden/sources.json or set EDEN_SOURCES_FILE.")
        print("- Hosted Eden instead: EDEN_URL + EDEN_API_KEY / EDEN_TENANT_ID.")
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the private build dir is scratch once artifacts are copied



if __name__ == "__main__":
    main()
