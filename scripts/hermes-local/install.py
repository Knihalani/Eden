#!/usr/bin/env python3
"""Install the extracted Eden release into one Hermes profile, without network access."""

import argparse
import hashlib
import json
import os
import platform
import re
import shlex
import shutil
import stat
import sys
import tempfile
from pathlib import Path

TARGETS = {
    "linux-x64": "bun-linux-x64-baseline",
    "linux-arm64": "bun-linux-arm64",
    "darwin-x64": "bun-darwin-x64",
    "darwin-arm64": "bun-darwin-arm64",
    "windows-x64": "bun-windows-x64-baseline",
    "windows-arm64": "bun-windows-arm64",
}
MARKER = ".eden-release.json"
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}")
PROFILE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")
COMPONENT = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*")
ENV_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)|%(\w+)%")
PYCACHE = re.compile(r"([A-Za-z_][A-Za-z0-9_]*)\.(?:cpython|pypy)-[0-9]+(?:\.opt-[0-9]+)?\.pyc")


def host_target(system, machine):
    arch = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine.lower())
    target = f"{system.lower()}-{arch}"
    if target not in TARGETS:
        raise ValueError(f"No Eden release for {system} {machine}")
    return target


def binary_name(target):
    return "eden-local.exe" if target.startswith("windows-") else "eden-local"


def digest(path):
    sha256 = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def plain(path, kind):
    info = path.lstat()
    if not kind(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
        raise ValueError(f"Unexpected file type: {path}")


def verify_tree(root, files, *, installed=False):
    plain(root, stat.S_ISDIR)
    parents = {parent.as_posix() for name in files for parent in Path(name).parents}
    seen = set()

    def fail(error):
        raise error

    for directory, dirs, names in os.walk(root, onerror=fail):
        here = Path(directory)
        for name in dirs:
            path = here / name
            plain(path, stat.S_ISDIR)
            cache = installed and name == "__pycache__" and here.relative_to(root).as_posix() in parents
            if path.relative_to(root).as_posix() not in parents and not cache:
                raise ValueError(f"Unexpected directory: {path}")
        for name in names:
            path = here / name
            rel = path.relative_to(root).as_posix()
            plain(path, stat.S_ISREG)
            if installed and rel == MARKER:
                continue
            if installed and here.name == "__pycache__":
                cache = PYCACHE.fullmatch(name)
                if cache and (here.parent / f"{cache[1]}.py").relative_to(root).as_posix() in files:
                    continue
            if rel not in files or digest(path) != files[rel]:
                raise ValueError(f"Unexpected or modified file: {path}")
            seen.add(rel)
    if seen != files.keys():
        raise ValueError(f"Missing files in {root}: {', '.join(sorted(files.keys() - seen))}")


def read_manifest(path):
    plain(path, stat.S_ISREG)
    manifest = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("format") != 1:
        raise ValueError(f"Invalid Eden release manifest: {path}")
    version, target, files = (manifest.get(key) for key in ("version", "target", "files"))
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ValueError(f"Invalid release version in {path}")
    if not isinstance(target, str) or target not in TARGETS or not isinstance(files, dict):
        raise ValueError(f"Invalid release target or files in {path}")
    required = {"__init__.py", "plugin.yaml", "eden_client/__init__.py", f"bin/{binary_name(target)}"}
    if not required <= files.keys():
        raise ValueError(f"Incomplete Eden release manifest: {path}")
    folded = set()
    for name, expected in files.items():
        if not (
            all(COMPONENT.fullmatch(part) and not part.endswith(".") for part in name.split("/"))
            and (name in required or not name.startswith("bin/"))
            and isinstance(expected, str)
            and re.fullmatch(r"[0-9a-f]{64}", expected)
            and name.casefold() not in folded
        ):
            raise ValueError(f"Invalid payload entry {name!r}")
        folded.add(name.casefold())
    return manifest


def expand_home(value, env):
    def replace(match):
        key = next(group for group in match.groups() if group is not None)
        if key not in env:
            raise ValueError(f"Undefined variable {key} in Hermes home")
        return env[key]

    return Path(ENV_REF.sub(replace, str(value))).expanduser().resolve()


def select_home(args, env, system, user_home):
    if args.hermes_home is not None:
        return expand_home(args.hermes_home, env)
    if system == "Windows":
        local = env.get("LOCALAPPDATA") or user_home / "AppData" / "Local"
        default = Path(local) / "hermes"
    else:
        default = user_home / ".hermes"
    override = env.get("HERMES_HOME", "").strip()
    home = expand_home(override or default, env)
    is_profile = home.parent.name == "profiles"
    name = args.profile.strip().lower() if args.profile is not None else None
    if is_profile and (name is None or name == home.name):
        return home
    root = home.parent.parent if is_profile else home
    if name is None:
        active = root / "active_profile"
        name = active.read_text(encoding="utf-8-sig").strip().lower() if active.is_file() else "default"
        name = name or "default"
    if not PROFILE.fullmatch(name):
        raise ValueError(f"Invalid Hermes profile name: {name!r}")
    if name == "default":
        return root
    profile = root / "profiles" / name
    if not profile.is_dir():
        raise ValueError(f"Hermes profile {name!r} does not exist: {profile}")
    return profile


def enable_command(home, system):
    flag = "" if home.parent.name == "profiles" else " --profile default"
    command = f"hermes{flag} plugins enable eden"
    if system == "Windows":
        quoted = str(home).replace("'", "''")
        return f"$env:HERMES_HOME = '{quoted}'; {command}"
    return f"HERMES_HOME={shlex.quote(str(home))} {command}"


def install(payload, manifest, home, force, dry_run):
    plugins = home / "plugins"
    dest = plugins / "eden"
    files = manifest["files"]
    verify_tree(payload, files)

    def existing():
        if os.path.lexists(plugins):
            plain(plugins, stat.S_ISDIR)
        if not os.path.lexists(dest):
            return None, False
        plain(dest, stat.S_ISDIR)
        try:
            previous = read_manifest(dest / MARKER)
            verify_tree(dest, previous["files"], installed=True)
        except (OSError, ValueError) as error:
            if not force:
                raise ValueError(f"Refusing to replace {dest}: {error}. Use --force to keep it in a backup.") from error
            return None, True
        return previous, False

    if dry_run:
        existing()
        print(f"Would install Eden {manifest['version']} into {dest}")
        return
    plugins.mkdir(parents=True, exist_ok=True)
    plain(plugins, stat.S_ISDIR)
    lock = plugins / ".eden-release-install.lock"
    try:
        lock.mkdir()
    except FileExistsError as error:
        raise ValueError(f"Another install may be running; check {lock} before removing it") from error
    try:
        previous, preserve = existing()
        if previous == manifest:
            (dest / "bin" / binary_name(manifest["target"])).chmod(0o755)
            print(f"Eden {manifest['version']} already installed in {dest}")
            return
        with tempfile.TemporaryDirectory(prefix=".eden-release-", dir=plugins) as work:
            stage = Path(work) / "eden"
            for rel in sorted(files):
                path = stage / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(payload / rel, path)
                path.chmod(0o755 if rel == f"bin/{binary_name(manifest['target'])}" else 0o644)
            verify_tree(stage, files)
            (stage / MARKER).write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")

            backup_dir = None
            if previous is not None or preserve:
                backup_dir = Path(tempfile.mkdtemp(prefix=".eden-backup-", dir=plugins))
                try:
                    dest.rename(backup_dir / "eden")
                except OSError:
                    backup_dir.rmdir()
                    raise
            try:
                stage.rename(dest)
            except OSError:
                if backup_dir is not None:
                    (backup_dir / "eden").rename(dest)
                    backup_dir.rmdir()
                raise
            if backup_dir is not None:
                if preserve:
                    print(f"Previous plugin preserved at {backup_dir / 'eden'}")
                else:
                    shutil.rmtree(backup_dir)
    finally:
        lock.rmdir()
    print(f"Installed Eden {manifest['version']} into {dest}")


def main():
    if sys.version_info < (3, 10):
        raise SystemExit("Eden's installer requires Python 3.10 or newer.")
    parser = argparse.ArgumentParser(description=__doc__)
    profile = parser.add_mutually_exclusive_group()
    profile.add_argument("--profile", help="select a named Hermes profile (or 'default')")
    profile.add_argument("--hermes-home", type=Path, help="install into this exact Hermes home, ignoring active_profile")
    parser.add_argument("--dry-run", action="store_true", help="check the release and destination without writing")
    parser.add_argument("--force", action="store_true", help="back up an existing unowned or modified Eden plugin")
    args = parser.parse_args()
    try:
        release = Path(__file__).resolve().parent
        manifest = read_manifest(release / "manifest.json")
        system = platform.system()
        target = host_target(system, platform.machine())
        if manifest["target"] != target:
            raise ValueError(f"This release is for {manifest['target']}; download {target} instead")
        home = select_home(args, os.environ, system, Path.home())
        install(release / "eden", manifest, home, args.force, args.dry_run)
        if not args.dry_run:
            print(f"Enable Eden in Hermes home {home}:\n  {enable_command(home, system)}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"eden install: {error}\n")


if __name__ == "__main__":
    main()
