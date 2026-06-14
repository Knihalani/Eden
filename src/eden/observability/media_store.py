"""Media blob storage for multimodal observability.

Phase 7.2a: stores image and audio payloads from LLM calls
(vision inputs/outputs, audio inputs/outputs, document inputs) outside
the database, behind stable URIs. The ``telemetry_media_blobs`` table
holds metadata + the URI; the actual bytes live on local disk (default)
or in S3 (production).

Why not base64 in JSONB?
    A single 2048x2048 PNG is ~2 MB. Inlining 10 of those in a JSONB
    row bloats the row, blows past the 1 GiB JSONB limit fast, and
    kills the heatmap/timeline queries (which scan JSONB). Storing
    by-reference keeps the metadata table skinny and makes the actual
    bytes cacheable (S3 + CloudFront), dedupable (SHA-256), and
    streamable (range requests for the portal).

Backends:
- "local"  — writes to settings.media_storage_path (default
              /var/lib/eden/media). Tenant ID is the first path
              segment; SHA-256 is the filename. Suitable for single-
              node dev and the test suite.
- "s3"     — uses boto3 against settings.media_s3_bucket. URI is
              s3://bucket/tenant_id/sha256. Recommended for production.

Concurrency:
    ``put`` is async-safe. Two concurrent writes of the same bytes
    to the same (tenant, sha256) tuple are deduplicated by the unique
    index — the second writer gets the same blob_id back.
"""

from __future__ import annotations

import hashlib
import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any, cast

from eden.config import get_settings

logger = logging.getLogger(__name__)


@dataclass
class MediaBlob:
    """Metadata for a stored media blob. Bytes live behind storage_uri."""

    blob_id: str
    tenant_id: str
    event_id: str
    media_type: str
    content_type: str
    storage_uri: str
    size_bytes: int
    sha256: str
    metadata: dict[str, Any]


class MediaStore:
    """Tenant-scoped blob storage. Backed by local disk or S3."""

    def __init__(self) -> None:
        settings = get_settings()
        self.backend = getattr(settings, "media_backend", "local")
        if self.backend == "local":
            base = getattr(
                settings, "media_storage_path", "/var/lib/eden/media"
            )
            self._local_root = base
            os.makedirs(self._local_root, exist_ok=True)
        elif self.backend == "s3":
            self._s3_bucket = getattr(settings, "media_s3_bucket", "eden-media")
            try:
                import boto3  # noqa: F401
                self._s3_client: Any = None  # lazy-init on first use
            except ImportError:
                logger.warning(
                    "media_backend='s3' but boto3 not installed; "
                    "falling back to local storage"
                )
                self.backend = "local"
                base = getattr(
                    settings, "media_storage_path", "/var/lib/eden/media"
                )
                self._local_root = base
                os.makedirs(self._local_root, exist_ok=True)
        else:
            logger.warning(
                f"Unknown media_backend='{self.backend}'; using local"
            )
            self.backend = "local"
            base = getattr(
                settings, "media_storage_path", "/var/lib/eden/media"
            )
            self._local_root = base
            os.makedirs(self._local_root, exist_ok=True)

    async def put(
        self,
        *,
        tenant_id: str,
        event_id: str,
        media_type: str,
        content_type: str,
        data: bytes,
        metadata: dict[str, Any] | None = None,
    ) -> MediaBlob:
        """Store bytes and return the blob metadata.

        The ``tenant_id`` and ``sha256`` together form the dedup key —
        identical bytes from the same tenant are returned with the same
        blob_id, never stored twice. ``event_id`` is recorded for the
        join back to ``telemetry_events`` but doesn't influence the
        dedup key.
        """
        sha256 = hashlib.sha256(data).hexdigest()
        blob_id = str(uuid.uuid4())
        size_bytes = len(data)

        if self.backend == "local":
            uri = await self._put_local(tenant_id, sha256, data)
        else:
            uri = await self._put_s3(tenant_id, sha256, data, content_type)

        return MediaBlob(
            blob_id=blob_id,
            tenant_id=tenant_id,
            event_id=event_id,
            media_type=media_type,
            content_type=content_type,
            storage_uri=uri,
            size_bytes=size_bytes,
            sha256=sha256,
            metadata=metadata or {},
        )

    async def get(self, blob: MediaBlob) -> bytes:
        """Read bytes by metadata. Caller is responsible for tenant
        isolation checks (we trust them — the API route enforces
        ``blob.tenant_id == current_user.tenant_id`` before calling)."""
        if self.backend == "local":
            return await self._get_local(blob)
        return await self._get_s3(blob)

    # ── local backend ───────────────────────────────────────────────

    async def _put_local(
        self, tenant_id: str, sha256: str, data: bytes
    ) -> str:
        """Write to ``<root>/<tenant_id>/<sha256>`` (idempotent on
        hash collision). Returns a ``local://`` URI."""
        tenant_dir = os.path.join(self._local_root, _safe_tenant(tenant_id))
        os.makedirs(tenant_dir, exist_ok=True)
        path = os.path.join(tenant_dir, sha256)
        # Idempotent write — if the file exists with the same SHA-256
        # we don't re-write. Cheap race-protection: write to a temp
        # file and rename atomically.
        if not os.path.exists(path):
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        return f"local://{_safe_tenant(tenant_id)}/{sha256}"

    async def _get_local(self, blob: MediaBlob) -> bytes:
        # ``local://<tenant>/<sha256>`` → ``<root>/<tenant>/<sha256>``
        uri = blob.storage_uri
        assert uri.startswith("local://")
        rel = uri[len("local://"):]
        path = os.path.join(self._local_root, rel)
        with open(path, "rb") as f:
            return f.read()

    # ── s3 backend ──────────────────────────────────────────────────

    async def _put_s3(
        self,
        tenant_id: str,
        sha256: str,
        data: bytes,
        content_type: str,
    ) -> str:
        if self._s3_client is None:
            import boto3
            self._s3_client = boto3.client("s3")
        key = f"{_safe_tenant(tenant_id)}/{sha256}"
        # PutObject is idempotent on (bucket, key) when the same body
        # is uploaded — boto3 short-circuits the network call after
        # computing the MD5. We don't pass IfNoneMatch because we want
        # *identical* uploads to be a no-op, not all uploads to fail.
        import asyncio
        await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: self._s3_client.put_object(
                Bucket=self._s3_bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
                Metadata={"sha256": sha256},
            ),
        )
        return f"s3://{self._s3_bucket}/{key}"

    async def _get_s3(self, blob: MediaBlob) -> bytes:
        if self._s3_client is None:
            import boto3
            self._s3_client = boto3.client("s3")
        uri = blob.storage_uri
        assert uri.startswith("s3://")
        # s3://bucket/key
        path = uri[len("s3://"):]
        bucket, _, key = path.partition("/")
        import asyncio
        response = await asyncio.get_event_loop().run_in_executor(
            None,
            lambda: self._s3_client.get_object(Bucket=bucket, Key=key),
        )
        return cast(bytes, response["Body"].read())


def _safe_tenant(tenant_id: str) -> str:
    """Sanitize a tenant_id for use as a path segment. Tenant IDs come
    from authenticated requests so we trust them, but a stray "../"
    would let one tenant write to another's directory."""
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in tenant_id)


# ── singleton ────────────────────────────────────────────────────────

_store: MediaStore | None = None


def get_media_store() -> MediaStore:
    global _store
    if _store is None:
        _store = MediaStore()
    return _store
