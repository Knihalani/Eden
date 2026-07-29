#!/usr/bin/env python3
"""Build a full runtime-environment payload for the eden-api service.

The Northflank runtime-environment route *sets* the environment rather
than merging into it, so a partial payload silently deletes everything
it omits. This merges the variables currently live on the service with
the plain-value variables northflank.yml declares, and writes the union.

Secret-backed variables are deliberately excluded: they are delivered by
the 31 secret groups already wired to the service, and this script never
sees their values.

    python scripts/build_nf_env_payload.py <live-service.json> <out.json>
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

# Variables whose absence changes production behaviour. Listed so the
# operator sees them called out rather than buried in a count.
NOTABLE = (
    "EDEN_PRODUCTION", "USE_MINIMAX", "TYPESENSE_ENABLED", "CLICKHOUSE_URL",
    "TINYBIRD_API_HOST", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE",
    "CLERK_JWKS_URL", "GITHUB_APP_SLUG", "MINIMAX_MODEL",
)


def main() -> int:
    live_path = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/nf-now.json")
    out_path = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/nf-env.json")

    doc = json.loads(live_path.read_text())
    svc = doc.get("service", doc)
    env = dict(svc.get("runtimeEnvironment") or {})
    if not env:
        print("refusing to build: live runtimeEnvironment read as empty.",
              file=sys.stderr)
        print("that would delete every variable on the service.", file=sys.stderr)
        return 2

    txt = (REPO / "northflank.yml").read_text()
    block = txt[txt.index("name: eden-api"):txt.index("name: eden-worker")]

    manifest: dict[str, str] = {}
    for name, body in re.findall(
        r"- name: ([A-Z0-9_]+)\n(.*?)(?=\n    - name: |\Z)", block, re.S
    ):
        if "secretKeyRef" in body:
            continue  # delivered by a secret group; never touch it here
        m = re.search(r'value:\s*"?([^"\n]*)"?', body)
        if m:
            manifest[name] = m.group(1).strip()

    add = {k: v for k, v in manifest.items() if k not in env}
    merged = {**env, **add}

    out_path.write_text(
        json.dumps({"runtimeEnvironment": merged}, indent=1, sort_keys=True)
    )

    print(f"preserved from live : {len(env)}")
    print(f"added from manifest : {len(add)}")
    print(f"total in payload    : {len(merged)}")
    print("\nbehaviour-changing additions:")
    for k in NOTABLE:
        if k in add:
            print(f"   {k:28} = {add[k]!r}")
    print("\npreserved untouched:")
    for k in sorted(env):
        print(f"   {k}")
    print(f"\nwrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
