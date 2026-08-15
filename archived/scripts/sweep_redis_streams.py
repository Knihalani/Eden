"""Redis stream balance sweep (2026-08-11).

Finds every Redis stream name that is XADDed (produced) vs XREADGROUP/XREAD
(consumed) in src/eden, and reports:
  A) streams produced but never consumed anywhere
  B) streams consumed but never produced (would block forever / only external)
"""

import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "eden"

# stream-name argument patterns used across the codebase
XADD = re.compile(r"xadd\s*\([^,]*,\s*[\"']([A-Za-z0-9._:-]+)[\"']")
XREAD = re.compile(r"xread(?:group)?\s*\([^,]*,\s*[\"']([A-Za-z0-9._:-]+)[\"']")
XGROUP = re.compile(r"xgroup_create\s*\([^,]*,\s*[\"']([A-Za-z0-9._:-]+)[\"']")
# also: xadd(stream, ...) positional-2 or keyword forms
XADD_KW = re.compile(r"xadd\s*\([^,]*,\s*stream\s*=\s*[\"']([A-Za-z0-9._:-]+)[\"']")
XREAD_KW = re.compile(r"xread(?:group)?\s*\([^,]*,\s*streams?\s*=\s*[\"']([A-Za-z0-9._:-]+)[\"']")


def main() -> None:
    producers: dict[str, set[str]] = {}
    consumers: dict[str, set[str]] = {}
    groups: dict[str, set[str]] = {}
    for f in SRC.rglob("*.py"):
        text = f.read_text(errors="ignore")
        rel = str(f.relative_to(ROOT))
        for pat, coll in (
            (XADD, producers),
            (XADD_KW, producers),
            (XREAD, consumers),
            (XREAD_KW, consumers),
            (XGROUP, groups),
        ):
            for m in pat.finditer(text):
                coll.setdefault(m.group(1), set()).add(rel)

    all_streams = sorted(set(producers) | set(consumers) | set(groups))
    print("=== Streams produced but never consumed (orphan producers) ===")
    orphans = 0
    for s in all_streams:
        if s in producers and s not in consumers and s not in groups:
            print(f"  {s}  <- produced by {sorted(producers[s])[:2]}")
            orphans += 1
    print(f"  ({orphans} total)")
    print()
    print("=== Streams consumed but never produced locally (external or dead) ===")
    ghost = 0
    for s in all_streams:
        if s in consumers and s not in producers:
            print(f"  {s}  <- consumed by {sorted(consumers[s])[:2]}")
            ghost += 1
    print(f"  ({ghost} total)")
    print()
    print("=== All stream names (quick inventory) ===")
    for s in all_streams:
        tags = []
        if s in producers:
            tags.append("PROD")
        if s in consumers:
            tags.append("CONS")
        if s in groups:
            tags.append("GROUP")
        print(f"  {s}: {','.join(tags)}")


if __name__ == "__main__":
    main()
