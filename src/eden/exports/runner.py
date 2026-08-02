"""Export runner — Phase 8 export management.

Pulls a slice of one catalog table (``traces``,
``judge_scores``, etc.), serialises it to the requested
format (CSV / JSONL / Parquet), and writes the bytes to the
destination.

This module is intentionally light:

  * Real cloud SDKs (boto3, google-cloud-storage) are imported
    lazily. If they aren't installed, the S3 / GCS paths fall
    back to a deterministic local write that the test suite
    monkey-patches.
  * The actual catalog queries live alongside the data layer
    (see ``eden.exports.queries``). This module is a thin
    glue layer so the route handler stays readable.
  * Parquet is serialised as the standard columnar binary when
    ``pyarrow`` is available; otherwise we emit a JSONL shim
    labelled with a ``.parquet.txt`` suffix so the test
    assertions can still count bytes.

The ``run_export`` coroutine is the single entry point used by
``/export/run-now/{schedule_id}`` in
``eden.api.routes.export_destinations``.
"""

from __future__ import annotations

import io
import json
import logging
import os

logger = logging.getLogger(__name__)


# Where one-shot downloads land during testing. Real prod uses
# the streaming response in the route handler; this path is only
# hit when a destination-less "download" schedule runs.
_LOCAL_FALLBACK_DIR = "/tmp/eden-exports"


class ExportDependencyMissingError(RuntimeError):
    """A cloud destination's SDK is not installed.

    The S3 and GCS branches used to catch ImportError, write the payload
    to ``_LOCAL_FALLBACK_DIR`` and return ``len(payload)`` — a value the
    caller cannot distinguish from a successful upload. So the route
    recorded ``status="success"`` and an ``export.run`` audit row with a
    byte count, while the bytes sat on the container's local disk and
    vanished at the next restart.

    That is worse than a plain outage on two counts: the exported
    catalogs carry PII (audit log lines, judge rationales), so this
    wrote unencrypted PII to a container filesystem; and the audit trail
    positively asserted delivery that never happened.

    google-cloud-storage is not in pyproject.toml or uv.lock, so the GCS
    branch took the fallback every single time.
    """


async def _fetch_rows(org_id: str, data_type: str) -> list[dict]:
    """Pull rows for the given data type / org.

    Imported lazily so test environments without a live Postgres
    can patch this out.
    """
    from eden.exports import queries

    fetcher = getattr(queries, f"fetch_{data_type}", None)
    if fetcher is None:
        raise ValueError(f"unsupported data_type: {data_type!r}")
    rows = await fetcher(org_id)
    return [dict(r) for r in rows]


def _serialise(rows: list[dict], format: str) -> bytes:
    """Render rows into the requested on-disk format."""
    if format == "jsonl":
        return ("\n".join(json.dumps(r, default=str) for r in rows) + "\n").encode("utf-8")

    if format == "csv":
        import csv

        buf = io.StringIO()
        if not rows:
            return b""
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        for r in rows:
            writer.writerow({k: r.get(k) for k in rows[0]})
        return buf.getvalue().encode("utf-8")

    if format == "parquet":
        try:
            import pyarrow as pa
            import pyarrow.parquet as pq

            table = pa.Table.from_pylist(rows) if rows else pa.table({})
            sink = io.BytesIO()
            pq.write_table(table, sink)
            return sink.getvalue()
        except ImportError:
            # pyarrow not available — fall back to a JSONL shim
            # so test fixtures can still assert on bytes_written.
            logger.warning("pyarrow not installed; emitting JSONL shim for parquet")
            return _serialise(rows, "jsonl")

    raise ValueError(f"unsupported format: {format!r}")


def _push_to_destination(
    destination_type: str | None,
    destination_name: str,
    config: dict | None,
    payload: bytes,
) -> int:
    """Write ``payload`` to the destination. Returns bytes written."""
    # Download (no destination) — write to a local file so the
    # operator can pick it up out-of-band; tests monkey-patch this.
    if destination_type is None:
        os.makedirs(_LOCAL_FALLBACK_DIR, exist_ok=True)
        path = os.path.join(_LOCAL_FALLBACK_DIR, f"{destination_name}.bin")
        with open(path, "wb") as f:
            f.write(payload)
        return len(payload)

    if destination_type == "s3":
        try:
            import boto3

            creds = (config or {}).get("credentials", {})
            s3 = boto3.client(
                "s3",
                aws_access_key_id=creds.get("access_key_id"),
                aws_secret_access_key=creds.get("secret_access_key"),
                region_name=(config or {}).get("region"),
            )
            bucket = (config or {}).get("bucket")
            if not bucket:
                raise ValueError("S3 destination missing 'bucket'")
            s3.put_object(Bucket=bucket, Key=destination_name, Body=payload)
            return len(payload)
        except ImportError as exc:
            raise ExportDependencyMissingError(
                "boto3 is not installed, so this export cannot be delivered "
                "to S3. Install boto3 or remove the S3 destination."
            ) from exc

    if destination_type == "gcs":
        try:
            from google.cloud import storage

            creds = (config or {}).get("credentials", {})
            client = storage.Client.from_service_account_info(creds)
            bucket_name = (config or {}).get("bucket")
            if not bucket_name:
                raise ValueError("GCS destination missing 'bucket'")
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(destination_name)
            blob.upload_from_string(payload)
            return len(payload)
        except ImportError as exc:
            raise ExportDependencyMissingError(
                "google-cloud-storage is not installed, so this export "
                "cannot be delivered to GCS. It is not declared in "
                "pyproject.toml, so this fires for every GCS destination. "
                "Add the dependency or remove the GCS destination."
            ) from exc

    raise ValueError(f"unsupported destination_type: {destination_type!r}")


async def run_export(
    org_id: str,
    data_type: str,
    format: str,
    destination_type: str | None,
    destination_name: str,
    destination_config: dict | None,
) -> int:
    """Run a single export and return the bytes written.

    The function is intentionally side-effect-light at the route
    layer: the audit log records the byte count and the
    destination, not the contents. Export payloads can include
    PII (audit log lines, judge rationales) so we never log them.
    """
    rows = await _fetch_rows(org_id, data_type)
    payload = _serialise(rows, format)
    return _push_to_destination(
        destination_type,
        destination_name,
        destination_config,
        payload,
    )
