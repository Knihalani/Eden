#!/usr/bin/env python3
"""Train the multi-dictionary zstd catalog used by Eden storage.

Produces ``var/zstd_dicts/{general,request_body,response_body,structured}.bin``
plus ``catalog.json``. Previous ``*.bin`` files are moved into
``var/zstd_dicts/archive/`` so old frames remain decompressible via dict_id.

Also refreshes ``var/zstd_dict.bin`` as a copy of ``general.bin`` for
legacy single-dict readers / Docker COPY compatibility.

Usage:
    PYTHONPATH=src:. python scripts/train_zstd_dicts.py --from-prod-weighted
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))
sys.path.insert(0, str(REPO))

from eden.storage.compression import (  # noqa: E402
    DEFAULT_DICT_SIZE,
    _to_json_bytes,
    train_dictionary,
)
from eden.storage.zstd_registry import (  # noqa: E402
    DEFAULT_COLUMN_TO_DICT,
    DEFAULT_DICT_SPECS,
    DICT_ID_GENERAL,
    DICT_ID_REQUEST,
    DICT_ID_RESPONSE,
    DICT_ID_STRUCTURED,
)


def _samples_prod_weighted(limit_per_bucket: int = 2500) -> dict[str, list[bytes]]:
    from bench.compression_prod_weighted import build_events

    buckets: dict[str, list[bytes]] = defaultdict(list)
    # Map field → dict bucket
    field_to_bucket = {
        "request_body": "request_body",
        "response_body": "response_body",
        "reasoning": "response_body",
        "tool_calls_full": "structured",
        "tool_results": "structured",
        "payload": "structured",
        "metrics": "structured",
        "attributes": "structured",
    }
    for ev in build_events(6000, seed=42):
        for name, val in zip(
            (
                "request_body",
                "response_body",
                "reasoning",
                "tool_calls_full",
                "tool_results",
                "payload",
                "metrics",
                "attributes",
            ),
            ev.as_fields(),
            strict=True,
        ):
            if val in (None, {}, []):
                continue
            raw = _to_json_bytes(val)
            if len(raw) < 40:
                continue
            bucket = field_to_bucket[name]
            if len(buckets[bucket]) < limit_per_bucket:
                buckets[bucket].append(raw)
            if len(buckets["general"]) < limit_per_bucket:
                buckets["general"].append(raw)
    return buckets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from-prod-weighted", action="store_true", default=True)
    parser.add_argument("--dict-size", type=int, default=DEFAULT_DICT_SIZE)
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=REPO / "var" / "zstd_dicts",
    )
    parser.add_argument(
        "--legacy-out",
        type=Path,
        default=REPO / "var" / "zstd_dict.bin",
        help="Also write general.bin bytes here for Docker/legacy path.",
    )
    args = parser.parse_args()

    buckets = _samples_prod_weighted()
    for name, samples in buckets.items():
        print(f"  bucket {name}: {len(samples)} samples", file=sys.stderr)
        if len(samples) < 100:
            print(f"ERROR: bucket {name} too small", file=sys.stderr)
            return 1

    out: Path = args.out_dir
    out.mkdir(parents=True, exist_ok=True)
    archive = out / "archive"
    archive.mkdir(exist_ok=True)

    # Archive existing write dicts before overwrite (keeps their dict_ids).
    for spec in DEFAULT_DICT_SPECS.values():
        src = out / spec["file"]
        if src.is_file():
            dest = archive / f"{src.stem}_{src.stat().st_mtime_ns}{src.suffix}"
            shutil.copy2(src, dest)
            print(f"  archived {src.name} -> {dest.name}", file=sys.stderr)

    id_map = {
        "general": DICT_ID_GENERAL,
        "request_body": DICT_ID_REQUEST,
        "response_body": DICT_ID_RESPONSE,
        "structured": DICT_ID_STRUCTURED,
    }
    sizes = {
        "general": args.dict_size,
        "request_body": args.dict_size,
        "response_body": args.dict_size,
        # structured fields are smaller/shorter — 8 KB is enough
        "structured": min(args.dict_size, 8192),
    }

    written: dict[str, dict] = {}
    for name, dict_id in id_map.items():
        samples = buckets[name]
        blob = train_dictionary(samples, dict_size=sizes[name], dict_id=dict_id)
        path = out / DEFAULT_DICT_SPECS[name]["file"]
        path.write_bytes(blob)
        written[name] = {"file": path.name, "dict_id": dict_id, "bytes": len(blob)}
        print(f"  wrote {path} ({len(blob)} bytes, dict_id={dict_id})", file=sys.stderr)

    catalog = {
        "version": 2,
        "write": DEFAULT_COLUMN_TO_DICT,
        "dicts": {
            name: {"file": meta["file"], "dict_id": meta["dict_id"]}
            for name, meta in written.items()
        },
    }
    (out / "catalog.json").write_text(json.dumps(catalog, indent=2) + "\n")
    print(f"  wrote {out / 'catalog.json'}", file=sys.stderr)

    # Legacy single-file mirror of general
    general = out / "general.bin"
    args.legacy_out.parent.mkdir(parents=True, exist_ok=True)
    args.legacy_out.write_bytes(general.read_bytes())
    print(f"  wrote legacy {args.legacy_out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
