#!/usr/bin/env python3
"""Install the Eden plugin for opencode: `~/.config/opencode/plugins/eden/` with a bundled `index.js`
+ `bin/eden-local`.

Run inside an Eden release archive (which ships `bin/eden-local`) or a repo checkout (where this builds
it with Bun). `--opencode-home PATH` installs somewhere other than `~/.config/opencode`.
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


def oc_home(args):
    if args.opencode_home:
        return Path(os.path.expandvars(args.opencode_home)).expanduser().resolve()
    default = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "opencode"
    return Path(os.environ.get("OPENCODE_HOME", default)).expanduser().resolve()


def bun_or_die():
    bun = shutil.which("bun")
    if not bun:
        sys.exit("Need Bun to build the plugin and, without a release archive, bin/eden-local")
    return bun


def ensure_binary(root, work):
    prebuilt = HERE / "bin" / "eden-local"
    if prebuilt.is_file():
        return prebuilt
    if not root:
        sys.exit("Need a repo checkout, or a release archive containing bin/eden-local")
    out = work / "eden-local"
    subprocess.run(
        [
            bun_or_die(),
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


def build_plugin(root, work):
    """Bundle eden.ts (with zod and @eden/client inlined) to a single zero-dependency index.js."""
    bundled = HERE / "index.js"
    if bundled.is_file():
        return bundled
    if not root:
        sys.exit("Need a repo checkout, or a release archive containing index.js")
    out = work / "index.js"
    subprocess.run(
        [
            bun_or_die(),
            "build",
            "--target=node",
            "--format=esm",
            f"--outfile={out}",
            str(HERE / "eden.ts"),
        ],
        cwd=root,
        check=True,
    )
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--opencode-home",
        metavar="PATH",
        help="opencode home directory (default: $OPENCODE_HOME or $XDG_CONFIG_HOME/opencode or ~/.config/opencode)",
    )
    args = parser.parse_args()
    root = find_root(HERE)
    work = Path(os.environ.get("TMPDIR", "/tmp")) / "eden-opencode-install"
    work.mkdir(parents=True, exist_ok=True)

    dest = oc_home(args) / "plugins" / "eden"
    if dest.is_dir():
        shutil.rmtree(dest)
    (dest / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copy2(build_plugin(root, work), dest / "index.js")
    # opencode loads immediate plugin-package directories; the manifest names the entry.
    (dest / "package.json").write_text(
        '{\n  "name": "eden",\n  "version": "0.0.0",\n  "type": "module",\n'
        '  "main": "index.js"\n}\n'
    )
    binary = ensure_binary(root, work)
    shutil.copy2(binary, dest / "bin" / "eden-local")
    (dest / "bin" / "eden-local").chmod(0o755)
    print(f"Eden installed to {dest}")
    print(f"Next: put sources in {oc_home(args)}/eden/sources.json (see README.md) and start a new opencode session.")


if __name__ == "__main__":
    main()
