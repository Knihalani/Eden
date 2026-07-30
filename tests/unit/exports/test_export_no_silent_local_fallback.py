"""An undeliverable export must never look like a delivered one.

``_push_to_destination`` used to catch ImportError for the S3 and GCS
branches, write the payload to /tmp/eden-exports, and return
``len(payload)``. The caller has only that integer to go on, so
``run_export_now`` recorded ``status="success"`` and an ``export.run``
audit row quoting the byte count — for bytes that never left the box
and disappeared on the next container restart.

google-cloud-storage is in neither pyproject.toml nor uv.lock, so the
GCS branch took that path on every single run. The exported catalogs
carry PII (audit log lines, judge rationales), which made this an
unencrypted PII write to container-local disk underneath an audit trail
that asserted successful delivery.

The destination-less "download" path legitimately writes locally; that
behaviour is intentional and must be preserved.
"""

from __future__ import annotations

import builtins
import os

import pytest

from eden.exports.runner import (
    ExportDependencyMissingError,
    _LOCAL_FALLBACK_DIR,
    _push_to_destination,
)

PAYLOAD = b'{"trace_id": "t1", "prompt": "sensitive user text"}\n'


@pytest.fixture
def no_cloud_sdks(monkeypatch):
    """Make `google.cloud.storage` and `boto3` unimportable."""
    real_import = builtins.__import__

    def _fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name in ("boto3",) or name.startswith("google"):
            raise ImportError(f"No module named {name!r}")
        return real_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", _fake_import)


class TestCloudDestinationsFailLoudly:
    @pytest.mark.parametrize("destination_type", ["gcs", "s3"])
    def test_missing_sdk_raises_instead_of_writing_locally(
        self, destination_type, no_cloud_sdks
    ):
        name = f"pytest-{destination_type}-export.jsonl"
        local_path = os.path.join(
            _LOCAL_FALLBACK_DIR, f"{destination_type}-{name}"
        )
        if os.path.exists(local_path):
            os.remove(local_path)

        with pytest.raises(ExportDependencyMissingError):
            _push_to_destination(
                destination_type=destination_type,
                destination_name=name,
                payload=PAYLOAD,
                config={"bucket": "some-bucket", "credentials": {}},
            )

        assert not os.path.exists(local_path), (
            "payload was written to container-local disk; the caller would "
            "record a successful delivery for bytes that never left the box"
        )

    @pytest.mark.parametrize("destination_type", ["gcs", "s3"])
    def test_error_message_names_the_missing_package(
        self, destination_type, no_cloud_sdks
    ):
        expected = {
            "gcs": "google-cloud-storage",
            "s3": "boto3",
        }[destination_type]
        with pytest.raises(ExportDependencyMissingError) as excinfo:
            _push_to_destination(
                destination_type=destination_type,
                destination_name="x.jsonl",
                payload=PAYLOAD,
                config={"bucket": "b", "credentials": {}},
            )
        assert expected in str(excinfo.value)


class TestDownloadStillWritesLocally:
    def test_destination_none_is_a_local_write_by_design(self):
        """The download path has no remote to fail to reach."""
        name = "pytest-download-export"
        written = _push_to_destination(
            destination_type=None,
            destination_name=name,
            payload=PAYLOAD,
            config=None,
        )
        assert written == len(PAYLOAD)
        path = os.path.join(_LOCAL_FALLBACK_DIR, f"{name}.bin")
        try:
            assert os.path.exists(path)
        finally:
            if os.path.exists(path):
                os.remove(path)


class TestSourceHasNoSilentFallback:
    def test_no_local_write_inside_a_cloud_branch(self):
        """Structural guard against the pattern coming back."""
        import inspect

        src = inspect.getsource(_push_to_destination)
        # Everything after the destination-less download block.
        _, _, cloud = src.partition('if destination_type == "s3"')
        assert "_LOCAL_FALLBACK_DIR" not in cloud, (
            "a cloud destination branch writes to local disk again; that "
            "return value is indistinguishable from a real upload"
        )
