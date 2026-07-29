#!/usr/bin/env python3
"""Which API routes have a consumer, and which have none.

Methodology, stated up front because the conclusion is only as good as
this: for every path in the live OpenAPI document, search every corpus
that could legitimately call it — the portal, all four SDKs, the docs
site, the examples, and the test suite. A route with no hit in any of
them has no known consumer.

Deliberately BIASED TOWARD "used". Telling someone to delete a live
endpoint is far worse than leaving a dead one in the list, so:

  * matching is on the most distinctive path segment, not the full
    path, because clients assemble URLs from fragments
  * a hit anywhere in any corpus counts, including comments and docs
  * anything ambiguous is reported as `used`, not `unused`

The output is therefore a LOWER bound on what is prunable. Treat
`no-consumer` as a candidate list to confirm, never as an instruction.

    python scripts/route_usage_audit.py            # summary
    python scripts/route_usage_audit.py --list     # every unused path
    python scripts/route_usage_audit.py --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API = "https://api.edenobservability.com/openapi.json"

# Directories that would swamp the search with vendored code.
EXCLUDE_PARTS = {
    "node_modules", ".venv", ".venv-test", "venv", "site-packages",
    "__pycache__", ".next", "dist", "build", ".git", ".mypy_cache",
    ".ruff_cache", ".pytest_cache", "target",
}

CORPORA: dict[str, list[tuple[Path, tuple[str, ...]]]] = {
    "portal": [(REPO / "clients" / "portal", (".ts", ".tsx", ".js", ".jsx"))],
    "sdk": [
        (REPO / "sdk" / "python", (".py",)),
        (REPO / "sdk" / "ts-ai" / "src", (".ts",)),
        (REPO / "sdk" / "go", (".go",)),
        (REPO / "sdk" / "rust" / "src", (".rs",)),
    ],
    "docs": [(REPO / "docs", (".md", ".mdx"))],
    "examples": [(REPO / "examples", (".py", ".ts", ".js", ".md"))],
    "tests": [(REPO / "tests", (".py",))],
}


def _load_corpus(entries: list[tuple[Path, tuple[str, ...]]]) -> str:
    chunks: list[str] = []
    for root, exts in entries:
        if not root.exists():
            continue
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix not in exts:
                continue
            if EXCLUDE_PARTS & set(path.parts):
                continue
            try:
                chunks.append(path.read_text(errors="ignore"))
            except Exception:
                continue
    return "\n".join(chunks)


def _signatures(path: str) -> list[str]:
    """Candidate literal fragments a client might contain for this route.

    Returns SEVERAL, and a hit on any counts as used. A single "longest
    literal run" is not enough: ``/auth/2fa/enforce`` yields the run
    ``auth/2fa/enforce``, but the portal writes ``2fa/enforce``, so the
    route was reported as having no consumer when it plainly has one.
    Telling someone to delete a live 2FA endpoint is the exact failure
    this whole script must not have, so it now tries the full run, its
    trailing pairs, and the final segment.
    """
    segs = [s for s in path.strip("/").split("/") if s]
    runs: list[list[str]] = []
    cur: list[str] = []
    for s in segs:
        if s.startswith("{"):
            if cur:
                runs.append(cur)
            cur = []
        elif s in ("orgs", "v1", "api"):
            if cur:
                runs.append(cur)
            cur = []
        else:
            cur.append(s)
    if cur:
        runs.append(cur)
    if not runs:
        return []

    out: set[str] = set()
    for run in runs:
        if len(run) >= 1:
            out.add("/".join(run))
        # trailing pairs and the tail segment — how clients usually
        # spell a route fragment
        for n in (3, 2):
            if len(run) >= n:
                out.add("/".join(run[-n:]))
        tail = run[-1]
        # A bare tail is only distinctive if it is reasonably long;
        # "run" or "status" would match half the codebase.
        if len(tail) >= 9:
            out.add(tail)
    return sorted(out, key=len, reverse=True)


def _signature(path: str) -> str:
    """Longest candidate — retained for callers that want one string."""
    sigs = _signatures(path)
    return sigs[0] if sigs else ""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--openapi", default=None, help="local openapi.json")
    args = ap.parse_args()

    if args.openapi:
        spec = json.loads(Path(args.openapi).read_text())
    else:
        with urllib.request.urlopen(API, timeout=90) as r:
            spec = json.load(r)

    paths = spec.get("paths", {})
    corpora = {name: _load_corpus(e) for name, e in CORPORA.items()}

    records = []
    for path, ops in sorted(paths.items()):
        sigs = _signatures(path)
        methods = sorted(m.upper() for m in ops if m in
                         ("get", "post", "put", "patch", "delete"))
        hits = [
            n for n, blob in corpora.items()
            if any(sg in blob for sg in sigs)
        ]
        records.append({
            "path": path,
            "methods": methods,
            "signature": sigs[0] if sigs else "",
            "consumers": hits,
        })

    unused = [r for r in records if not r["consumers"]]
    test_only = [r for r in records if r["consumers"] == ["tests"]]
    used = [r for r in records if set(r["consumers"]) - {"tests"}]

    if args.json:
        print(json.dumps({
            "total": len(records),
            "no_consumer": len(unused),
            "test_only": len(test_only),
            "used": len(used),
            "unused_paths": [r["path"] for r in unused],
            "test_only_paths": [r["path"] for r in test_only],
        }, indent=2))
        return 0

    print("=" * 74)
    print("ROUTE CONSUMER AUDIT")
    print("=" * 74)
    print(f"  routes in live OpenAPI      : {len(records)}")
    print(f"  referenced by a real client : {len(used)}")
    print(f"  referenced ONLY by tests    : {len(test_only)}")
    print(f"  NO consumer anywhere        : {len(unused)}")
    print()
    print("  corpus sizes (chars):")
    for n, blob in corpora.items():
        print(f"    {n:10}{len(blob):>12,}")

    fam = Counter()
    for r in unused + test_only:
        seg = re.sub(r"/orgs/\{org_id\}", "", r["path"]).strip("/").split("/")[0]
        fam[seg or "(root)"] += 1
    print()
    print("  prune candidates by family (no consumer, or tests only):")
    for k, v in fam.most_common(20):
        print(f"    {k[:38]:40}{v:>5}")

    if args.list:
        print()
        print("  NO CONSUMER ANYWHERE:")
        for r in unused:
            print(f"    {','.join(r['methods']):18} {r['path']}")
        print()
        print("  TEST-ONLY (route exists solely to satisfy its own test):")
        for r in test_only:
            print(f"    {','.join(r['methods']):18} {r['path']}")

    print()
    print("  NOTE: biased toward 'used'. This is a LOWER bound on what is")
    print("  prunable — confirm each before deleting anything.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
