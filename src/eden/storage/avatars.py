"""Avatar blob storage with S3 backend and local-disk fallback.

Local storage is preferred when S3 is not configured (empty bucket or
backend unset). This keeps dev/test frictionless while production can
point at the shared object store.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
from pathlib import Path

from eden.config import get_settings

logger = logging.getLogger(__name__)

_EXT_MAP = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _local_upload_root() -> Path:
    settings = get_settings()
    root = os.environ.get("EDEN_UPLOAD_DIR") or getattr(
        settings, "eden_upload_dir", "/tmp/eden-uploads"
    )
    return Path(root)


def _use_s3() -> bool:
    """Return True when S3 avatar storage is configured."""
    settings = get_settings()
    backend = (getattr(settings, "avatar_storage_backend", "local") or "local").lower()
    if backend == "local":
        return False
    # Explicit s3 backend requires a bucket; otherwise fall back to local.
    bucket = (getattr(settings, "avatar_s3_bucket", "") or "").strip()
    if not bucket:
        bronze = (getattr(settings, "bronze_s3_bucket", "") or "").strip()
        bucket = bronze
    return bool(bucket)


def _s3_bucket() -> str:
    settings = get_settings()
    bucket = (getattr(settings, "avatar_s3_bucket", "") or "").strip()
    if bucket:
        return bucket
    return (getattr(settings, "bronze_s3_bucket", "") or "").strip()


_S3_CLIENT = None


def _make_s3_client():
    """Return a process-wide boto3 S3 client (K20 singleton)."""
    global _S3_CLIENT
    if _S3_CLIENT is not None:
        return _S3_CLIENT
    import boto3

    settings = get_settings()
    endpoint = (getattr(settings, "eden_storage_endpoint", "") or "").strip()
    access_key = (getattr(settings, "eden_storage_access_key", "") or "").strip()
    secret_key = (getattr(settings, "eden_storage_secret_key", "") or "").strip()
    kwargs: dict = {}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    if access_key and secret_key:
        kwargs["aws_access_key_id"] = access_key
        kwargs["aws_secret_access_key"] = secret_key
    _S3_CLIENT = boto3.client("s3", **kwargs)
    return _S3_CLIENT


def get_s3_client():
    """Public accessor for the shared S3 client."""
    return _make_s3_client()


async def store_avatar(user_id: str, blob: bytes, content_type: str) -> str:
    """Persist avatar bytes and return the public URL path or URI."""
    ext = _EXT_MAP.get(content_type, ".bin")
    filename = f"{secrets.token_urlsafe(16)}{ext}"
    key = f"avatars/{user_id}/{filename}"

    if _use_s3():
        bucket = _s3_bucket()
        client = get_s3_client()
        await asyncio.to_thread(
            client.put_object,
            Bucket=bucket,
            Key=key,
            Body=blob,
            ContentType=content_type,
        )
        public_base = (getattr(get_settings(), "avatar_public_base_url", "") or "").strip()
        if public_base:
            return f"{public_base.rstrip('/')}/{key}"
        return f"s3://{bucket}/{key}"

    avatars_dir = _local_upload_root() / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    (avatars_dir / filename).write_bytes(blob)
    return f"/uploads/avatars/{filename}"
