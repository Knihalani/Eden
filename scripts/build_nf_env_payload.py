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

# Env names already owned by a project secret group. northflank.yml
# declares CLERK_JWKS_URL as a plain value AND the project has a
# CLERK-JWKS-URL group; writing the plain value into the service's own
# runtime environment could shadow the group's. Secret groups keep
# ownership of anything they supply — this script never competes with
# them. Derived from `northflank list secrets` (31 single-key groups,
# hyphenated names) with hyphens normalised to underscores.
SECRET_GROUP_ENV = {
    "JWT_SECRET", "ENCRYPTION_KEY", "SESSION_SECRET", "OPENROUTER_API_KEY",
    "TINYBIRD_ADMIN_TOKEN", "TINYBIRD_BRANCH_TOKEN", "SENTRY_DSN",
    "GITHUB_APP_ID", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET",
    "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_WEBHOOK_SECRET", "REDIS_URL",
    "QDRANT_API_KEY", "POSTGRES_PASSWORD", "CLERK_JWKS_URL", "DATABASE_URL",
    "POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER",
    "POSTGRES_SSLMODE", "BRONZE_S3_BUCKET", "EDEN_STORAGE_BACKEND",
    "EDEN_STORAGE_ENDPOINT", "EDEN_STORAGE_ACCESS_KEY",
    "EDEN_STORAGE_SECRET_KEY", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY",
    "CLERK_WEBHOOK_SIGNING_SECRET", "SENDKIT_API_KEY",
}

# Keys where the manifest value should be pushed over whatever is live.
# Everything else keeps the live value, because the manifest was stale
# about several of them and overwriting blindly would have narrowed
# CORS_ORIGINS_RAW enough to break the www subdomain.
#
# CORS_ORIGINS_RAW: production currently allows http://localhost:3000
# and http://127.0.0.1:3000 with allow_credentials=True, so any page on
# any developer machine can make credentialed calls against prod. The
# portal does not need it — NEXT_PUBLIC_API_URL is /api/proxy, a
# same-origin Next route, and the server-side hop to API_INTERNAL_URL
# sends no Origin header and is not subject to CORS at all. Verified
# against the live API: localhost:3000 is echoed back in
# access-control-allow-origin; an unknown origin is correctly refused.
MANIFEST_WINS = ("CORS_ORIGINS_RAW",)

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

    shadowed = sorted(
        k for k in manifest if k not in env and k in SECRET_GROUP_ENV
    )
    add = {
        k: v for k, v in manifest.items()
        if k not in env and k not in SECRET_GROUP_ENV
    }
    merged = {**env, **add}

    # Live normally wins for keys already set — the manifest was stale
    # about several of them, and blindly overwriting would have narrowed
    # CORS_ORIGINS_RAW enough to break the www subdomain. MANIFEST_WINS
    # is the explicit exception list: keys where the manifest value is a
    # deliberate, reviewed decision that should be pushed over live.
    overridden = []
    for k in MANIFEST_WINS:
        if k in manifest and merged.get(k) != manifest[k]:
            overridden.append((k, merged.get(k), manifest[k]))
            merged[k] = manifest[k]

    out_path.write_text(
        json.dumps({"runtimeEnvironment": merged}, indent=1, sort_keys=True)
    )

    print(f"preserved from live : {len(env)}")
    print(f"added from manifest : {len(add)}")
    print(f"left to secret group: {len(shadowed)} {shadowed}")
    print(f"total in payload    : {len(merged)}")
    if overridden:
        print("\nmanifest overrides live (MANIFEST_WINS):")
        for k, was, now in overridden:
            print(f"   {k}\n     was: {was}\n     now: {now}")
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
