#!/usr/bin/env python3
"""Regenerate portal SDK reference docs from the live OpenAPI spec.

Phase 6.6.3: wires `eden.sdk.openapi_generator.OpenAPIGenerator` to the
portal `/docs` page so the docs stay in sync with the API.

Usage:
    # Run against a live API
    EDEN_API_URL=http://localhost:8000 python scripts/generate_sdk_docs.py

    # Run against a saved OpenAPI JSON file
    python scripts/generate_sdk_docs.py --from-file openapi.json

Outputs:
    clients/portal/src/lib/sdk-reference.json   (used by /docs page)
    docs/sdk-reference.md                        (human-readable)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

# Make `src/` importable when run directly
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from eden.sdk.openapi_generator import OpenAPIGenerator  # noqa: E402


async def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--api-url",
        default="http://localhost:8000",
        help="Base URL of the Eden API (default: %(default)s)",
    )
    parser.add_argument(
        "--from-file",
        type=Path,
        help="Load OpenAPI spec from a local file instead of fetching",
    )
    parser.add_argument(
        "--out-json",
        type=Path,
        default=ROOT / "clients/portal/src/lib/sdk-reference.json",
        help="Where to write the structured SDK reference (default: %(default)s)",
    )
    parser.add_argument(
        "--out-md",
        type=Path,
        default=ROOT / "docs/sdk-reference.md",
        help="Where to write the human-readable markdown (default: %(default)s)",
    )
    args = parser.parse_args()

    gen = OpenAPIGenerator(api_url=args.api_url)

    if args.from_file:
        spec = json.loads(args.from_file.read_text())
    else:
        spec = await gen.fetch_spec()

    endpoints = gen.parse_endpoints(spec)
    md = gen.generate_markdown(endpoints, spec)
    ts = gen.generate_typescript_types(endpoints, spec)

    args.out_json.parent.mkdir(parents=True, exist_ok=True)
    args.out_md.parent.mkdir(parents=True, exist_ok=True)

    args.out_md.write_text(md)
    args.out_json.write_text(
        json.dumps(
            {
                "endpoints": endpoints,
                "typescript": ts,
                "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
            },
            indent=2,
        )
    )

    print(f"Wrote {args.out_md} ({len(endpoints)} endpoints)")
    print(f"Wrote {args.out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
