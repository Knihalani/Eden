"""Enable scalar int8 quantization + on_disk_payload on Eden's Qdrant collections.

Phase B6 of the Eden app/storage plan (2026-06-19). For existing
collections in production. New collections get these flags by default
via ``QdrantClientWrapper.initialize_collections``.

Quantization reduces vector RAM by ~4x (1536-dim float32 → int8) with
<1% recall loss on MTEB benchmarks. on_disk_payload mmap's the
(usually large) payload to disk while keeping the vector index in RAM.

Usage:
    # Dry run — show what would happen, no changes
    uv run python scripts/qdrant_enable_quantization.py --dry-run

    # Production — reindex in place
    uv run python scripts/qdrant_enable_quantization.py --no-dry-run

    # Validate recall on a 1k sample after reindex
    uv run python scripts/qdrant_enable_quantization.py --validate-recall

Pre-flight: a Qdrant snapshot is created before any destructive
operation (``client.create_snapshot``). If recall validation fails,
restore via ``client.recover_snapshot``.

Why a separate script and not a one-off alembic migration
---------------------------------------------------------
Qdrant reindex is not transactional and cannot be rolled back
inside an alembic migration. Running it out-of-band is the standard
pattern (matches ``scripts/backfill_zstd_payloads.py``).
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from typing import Any

from qdrant_client import QdrantClient
from qdrant_client.http import models

from eden.config import get_settings

logger = logging.getLogger(__name__)


COLLECTIONS = [
    ("eden_semantic_memory", 1536, models.Distance.COSINE),
    ("eden_skills", 1536, models.Distance.COSINE),
    ("eden_exploits", 1536, models.Distance.COSINE),
]


def make_client() -> QdrantClient:
    """Build a QdrantClient from Settings — same logic as the wrapper."""
    s = get_settings()
    if s.qdrant_https and s.qdrant_api_key:
        return QdrantClient(
            url=f"https://{s.qdrant_host}:{s.qdrant_port}",
            api_key=s.qdrant_api_key,
        )
    return QdrantClient(host=s.qdrant_host, port=s.qdrant_port)


def snapshot(client: QdrantClient, collection: str) -> str:
    """Create a snapshot of the collection before destructive ops.

    Returns the snapshot name. Caller is responsible for keeping it
    around long enough to recover if recall validation fails.
    """
    snap = client.create_snapshot(collection_name=collection)
    name = snap.name
    logger.info(f"[{collection}] snapshot created: {name}")
    return name


def count_points(client: QdrantClient, collection: str) -> int:
    """Return the number of points in the collection."""
    info = client.get_collection(collection_name=collection)
    # qdrant-client >=1.10 returns ``points_count``; older returns
    # ``vectors_count``. Handle both.
    return getattr(info, "points_count", None) or getattr(info, "vectors_count", 0) or 0


def scroll_all(client: QdrantClient, collection: str, batch: int = 100) -> list[Any]:
    """Scroll every point in the collection. Returns a flat list.

    Uses ``with_payload`` (singular) — the qdrant-client 1.7+ name.
    Earlier versions used ``with_payloads`` (plural) which now
    raises ``Unknown arguments``.
    """
    points: list[Any] = []
    offset: Any = None
    while True:
        batch_points, next_offset = client.scroll(
            collection_name=collection,
            limit=batch,
            offset=offset,
            with_vectors=True,
            with_payload=True,
        )
        points.extend(batch_points)
        if next_offset is None:
            break
        offset = next_offset
    return points


def reindex(
    client: QdrantClient,
    collection: str,
    dim: int,
    distance: models.Distance,
    dry_run: bool,
) -> None:
    """Drop, recreate with quantization, re-upsert all points.

    Qdrant does not support changing quantization in-place on an
    existing collection (see qdrant-client docs); the only path is
    delete + create + re-upsert. Snapshot is taken first.
    """
    n = count_points(client, collection)
    logger.info(f"[{collection}] {n} points; reindex dry_run={dry_run}")

    if dry_run:
        logger.info(f"[{collection}] would: snapshot, delete, recreate with int8, re-upsert")
        return

    snap = snapshot(client, collection)
    points = scroll_all(client, collection, batch=500)
    client.delete_collection(collection_name=collection)
    client.create_collection(
        collection_name=collection,
        vectors_config=models.VectorParams(
            size=dim,
            distance=distance,
            on_disk=True,
        ),
        quantization_config=models.ScalarQuantization(
            scalar=models.ScalarQuantizationConfig(
                type=models.ScalarType.INT8,
                quantile=0.99,
                always_ram=True,
            ),
        ),
        on_disk_payload=True,
    )
    # Re-upsert in batches of 100
    for i in range(0, len(points), 100):
        client.upsert(collection_name=collection, points=points[i : i + 100], wait=False)
    logger.info(f"[{collection}] reindexed {len(points)} points (snapshot {snap} retained)")


def validate_recall(client: QdrantClient, collection: str, sample: int = 1000) -> bool:
    """Sample N points; for each, search the index and check recall.

    Pass criterion: ≥0.99 of the sampled points return themselves in
    the top-1 of a k=10 search (1-NN self-recall).
    """
    points = scroll_all(client, collection, batch=500)
    if len(points) < sample:
        sample = len(points)
    subset = points[:sample]

    hits = 0
    for p in subset:
        if p.vector is None:
            continue
        # 1-NN self-recall: search with the point's own vector, expect itself in top-1
        results = client.search(
            collection_name=collection,
            query_vector=p.vector,
            limit=1,
        )
        if results and str(results[0].id) == str(p.id):
            hits += 1
    recall = hits / sample
    logger.info(f"[{collection}] recall@{sample} = {recall:.4f} (threshold 0.99)")
    return recall >= 0.99


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", default=True)
    parser.add_argument("--no-dry-run", dest="dry_run", action="store_false")
    parser.add_argument("--validate-recall", action="store_true", help="Skip reindex; only run recall check")
    parser.add_argument("--batch-size", type=int, default=500, help="Scroll batch size")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = make_client()

    if args.validate_recall:
        ok = True
        for name, _dim, _dist in COLLECTIONS:
            if not validate_recall(client, name):
                ok = False
        return 0 if ok else 1

    start = time.monotonic()
    for name, dim, dist in COLLECTIONS:
        try:
            reindex(client, name, dim, dist, dry_run=args.dry_run)
        except Exception as exc:
            logger.error(f"[{name}] FAILED: {exc}")
            return 1
    logger.info(f"All done in {time.monotonic() - start:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
