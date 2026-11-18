#!/usr/bin/env python3
"""Cross-compile Eden and package one offline Hermes installer ZIP per target."""

import argparse
import json
import lzma
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from install import TARGETS, VERSION, binary_name, digest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def bun_version():
    pm = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["packageManager"]
    pinned = pm.removeprefix("bun@")
    actual = subprocess.check_output(["bun", "--version"], text=True).strip()
    if actual != pinned:
        raise ValueError(f"Eden pins Bun {pinned}, but PATH has Bun {actual}")
    return actual


def release_sources():
    plugin = ROOT / "examples" / "hermes" / "eden"
    client = ROOT / "packages" / "client-python" / "eden_client"
    return {
        f"{prefix}{path.relative_to(root).as_posix()}": path
        for root, prefix in [(plugin, ""), (client, "eden_client/")]
        for path in root.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix in (".py", ".yaml", ".typed")
    }


def reproducible_zip(outfile, entries, executable):
    with zipfile.ZipFile(outfile, "w") as archive:
        for name, source in sorted(entries.items()):
            member = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            member.create_system = 3
            member.external_attr = (stat.S_IFREG | (0o755 if name == executable else 0o644)) << 16
            member.compress_type = zipfile.ZIP_STORED if name.endswith(".xz") else zipfile.ZIP_DEFLATED
            member.file_size = source.stat().st_size
            with source.open("rb") as data, archive.open(member, "w") as dest:
                shutil.copyfileobj(data, dest)


def build(target, version, output):
    executable = f"bin/{binary_name(target)}"
    archive_name = f"eden-hermes-local-{version}-{target}.zip"
    with tempfile.TemporaryDirectory(prefix=".eden-build-", dir=output) as directory:
        work = Path(directory)
        binary = work / binary_name(target)
        subprocess.run(
            [
                "bun", "build", "--compile", f"--target={TARGETS[target]}",
                "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig",
                "--bytecode",
                f"--outfile={binary}", "packages/server/src/main.ts",
            ],
            cwd=ROOT,
            check=True,
        )
        # xz beats zip deflate on the Bun runtime (~119 MB -> ~42 MB) and Python's lzma
        # module unpacks it offline; the manifest records the decompressed digest.
        packed = work / f"{binary.name}.xz"
        with binary.open("rb") as data, lzma.open(packed, "wb", preset=9 | lzma.PRESET_EXTREME) as out:
            shutil.copyfileobj(data, out)
        files = {**release_sources(), executable: binary}
        manifest = work / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "format": 1, "target": target, "version": version,
                    "files": {name: digest(path) for name, path in files.items()},
                    "packed": [executable],
                },
                sort_keys=True,
                indent=2,
            ) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        archive = work / archive_name
        reproducible_zip(
            archive,
            {
                **{f"eden/{name}.xz" if name == executable else f"eden/{name}": (packed if name == executable else path)
                   for name, path in files.items()},
                "install.py": HERE / "install.py",
                "GETTING-STARTED.md": HERE / "GETTING-STARTED.md",
                "LICENSE": ROOT / "LICENSE",
                "manifest.json": manifest,
            },
            f"eden/{executable}",
        )
        print(f"{target}: {binary.stat().st_size} bytes executable, {packed.stat().st_size} packed; "
              f"{archive.stat().st_size} bytes ZIP", flush=True)
        return archive.replace(output / archive_name)


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Eden's release build requires Python 3.10 or newer.")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True, help="release label used in artifact names")
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--target", choices=sorted(TARGETS), action="append", help="repeat to build a subset")
    args = parser.parse_args()
    if not VERSION.fullmatch(args.version):
        parser.error("invalid release version")
    try:
        bun_version()
        output = args.out_dir.resolve()
        output.mkdir(parents=True, exist_ok=True)
        targets = sorted(set(args.target or TARGETS))
        with tempfile.TemporaryDirectory(prefix=".eden-release-", dir=output) as directory:
            work = Path(directory)
            archives = sorted(build(target, args.version, work) for target in targets)
            checksums = work / "SHA256SUMS"
            checksums.write_text(
                "".join(f"{digest(path)}  {path.name}\n" for path in archives), encoding="ascii", newline="\n"
            )
            for path in [*archives, checksums]:
                os.replace(path, output / path.name)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"eden build: {error}\n")


if __name__ == "__main__":
    main()
