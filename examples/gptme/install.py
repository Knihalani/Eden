#!/usr/bin/env python3
"""Install the Eden plugin for gptme: `~/.config/gptme/plugins/eden/` + the `eden_client` package vendored
into `vendor/` + `bin/eden-local`.

Run inside an Eden release archive (which ships `bin/eden-local`) or a repo checkout (where this builds it
with Bun). `--gptme-home PATH` installs somewhere other than `~/.config/gptme`.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def gptme_home(args):
    if args.gptme_home:
        return Path(os.path.expandvars(args.gptme_home)).expanduser().resolve()
    default = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "gptme"
    return Path(os.environ.get("GPTME_HOME", default)).expanduser().resolve()


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gptme-home",
        metavar="PATH",
        help="gptme home directory (default: $GPTME_HOME or $XDG_CONFIG_HOME/gptme or ~/.config/gptme)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(os.environ.get("TMPDIR", "/tmp")) / "eden-gptme-install"
    work.mkdir(parents=True, exist_ok=True)

    dest = gptme_home(args) / "plugins" / "eden"
    vendor = dest / "vendor" / "eden_client"
    if dest.is_dir():
        shutil.rmtree(dest)
    (dest / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        HERE / "plugin" / "eden",
        dest,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    client_src = (root or HERE) / "packages" / "client-python" / "eden_client"
    if not client_src.is_dir():
        sys.exit("Need a repo checkout or release archive containing packages/client-python/eden_client")
    shutil.copytree(
        client_src,
        vendor,
        dirs_exist_ok=True,
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
    )
    binary = ensure_binary(root, work)
    shutil.copy2(binary, dest / "bin" / "eden-local")
    (dest / "bin" / "eden-local").chmod(0o755)
    print(f"Eden installed to {dest}")
    print(f"Next: put sources in {gptme_home(args)}/eden/sources.json (see README.md) and start a new gptme session.")


if __name__ == "__main__":
    main()
