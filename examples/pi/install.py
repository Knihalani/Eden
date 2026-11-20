#!/usr/bin/env python3
"""Install the Eden extension for Pi: `~/.pi/agent/extensions/eden/index.js` + `bin/eden-local`.

Run inside an Eden release archive (which ships `index.js` and `bin/eden-local`) or a repo checkout
(where this builds both with Bun). `--pi-home PATH` installs somewhere other than `~/.pi`.
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


def find_root(start):
    for d in [start, *start.parents]:
        if (d / "packages" / "server" / "src" / "main.ts").is_file():
            return d
    return None


def pi_home(args):
    if args.pi_home:
        return Path(os.path.expandvars(args.pi_home)).expanduser().resolve()
    return Path(os.environ.get("PI_HOME", Path.home() / ".pi")).expanduser().resolve()


def ensure_bundle(root, work):
    prebuilt = HERE / "index.js"
    if prebuilt.is_file():
        return prebuilt
    bun = shutil.which("bun")
    if not root or not bun:
        sys.exit("Need Bun and a repo checkout, or a release archive containing index.js")
    out = work / "index.js"
    subprocess.run(
        [bun, "build", "--target=node", f"--outfile={out}", "examples/pi/eden.ts"], cwd=root, check=True
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pi-home",
        metavar="PATH",
        help="Pi home directory (default: $PI_HOME or ~/.pi)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(tempfile.mkdtemp(prefix="eden-pi-install-"))
    try:
        bundle = ensure_bundle(root, work)
        binary = ensure_binary(root, work)

        dest = pi_home(args) / "agent" / "extensions" / "eden"
        (dest / "bin").mkdir(parents=True, exist_ok=True)
        shutil.copy2(bundle, dest / "index.js")
        # Rename staged in the same directory: copy2 over a still-running detached server fails
        # ETXTBSY on Linux, and a cross-filesystem rename fails EXDEV.
        staged = dest / "bin" / f".eden-local.{os.getpid()}.tmp"
        shutil.copy2(binary, staged)
        staged.chmod(0o755)
        os.replace(staged, dest / "bin" / "eden-local")
        print(f"Eden installed to {dest}")
        print("Next: put sources in ~/.pi/eden/sources.json (see README.md) and start a new Pi session.")
    finally:
        shutil.rmtree(work, ignore_errors=True)  # the private build dir is scratch once artifacts are copied



if __name__ == "__main__":
    main()
