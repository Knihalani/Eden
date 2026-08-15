"""Unit tests for unified-diff materialization."""

from __future__ import annotations

import pytest

from eden.patches.diff_materializer import (
    DiffMaterializeError,
    materialize_unified_diff,
)


@pytest.mark.asyncio
async def test_materialize_modify_returns_patched_source() -> None:
    base = {"foo.py": "old\n"}

    async def read_file(path: str) -> str:
        return base.get(path, "")

    diff = """--- a/foo.py
+++ b/foo.py
@@ -1 +1 @@
-old
+new
"""
    files = await materialize_unified_diff(diff, read_file=read_file)
    assert len(files) == 1
    assert files[0].path == "foo.py"
    assert files[0].content == "new\n"
    # Must be full source, not hunk body text.
    assert "@@" not in files[0].content
    assert not files[0].content.startswith("-")
    assert not files[0].content.startswith("+")


@pytest.mark.asyncio
async def test_materialize_new_file_from_dev_null() -> None:
    async def read_file(path: str) -> str:
        return ""

    diff = """--- /dev/null
+++ b/bar.py
@@ -0,0 +1,2 @@
+hello
+world
"""
    files = await materialize_unified_diff(diff, read_file=read_file)
    assert len(files) == 1
    assert files[0].path == "bar.py"
    assert files[0].content == "hello\nworld\n"


@pytest.mark.asyncio
async def test_materialize_multi_file_gathers_reads() -> None:
    base = {
        "a.py": "alpha\n",
        "b.py": "beta\n",
    }
    reads: list[str] = []

    async def read_file(path: str) -> str:
        reads.append(path)
        return base.get(path, "")

    diff = """diff --git a/a.py b/a.py
--- a/a.py
+++ b/a.py
@@ -1 +1 @@
-alpha
+ALPHA
diff --git a/b.py b/b.py
--- a/b.py
+++ b/b.py
@@ -1 +1 @@
-beta
+BETA
"""
    files = await materialize_unified_diff(diff, read_file=read_file)
    assert {f.path: f.content for f in files} == {
        "a.py": "ALPHA\n",
        "b.py": "BETA\n",
    }
    assert set(reads) == {"a.py", "b.py"}


@pytest.mark.asyncio
async def test_materialize_context_mismatch_fail_closed() -> None:
    async def read_file(path: str) -> str:
        return "actual\n"

    diff = """--- a/foo.py
+++ b/foo.py
@@ -1 +1 @@
-expected
+new
"""
    with pytest.raises(DiffMaterializeError, match="context mismatch"):
        await materialize_unified_diff(diff, read_file=read_file)


@pytest.mark.asyncio
async def test_materialize_missing_base_for_modify_fail_closed() -> None:
    async def read_file(path: str) -> str:
        return ""

    diff = """--- a/missing.py
+++ b/missing.py
@@ -1 +1 @@
-old
+new
"""
    with pytest.raises(DiffMaterializeError, match="missing base"):
        await materialize_unified_diff(diff, read_file=read_file)


@pytest.mark.asyncio
async def test_materialize_binary_diff_fail_closed() -> None:
    async def read_file(path: str) -> str:
        return ""

    diff = """diff --git a/img.bin b/img.bin
Binary files a/img.bin and b/img.bin differ
"""
    with pytest.raises(DiffMaterializeError, match="binary"):
        await materialize_unified_diff(diff, read_file=read_file)


@pytest.mark.asyncio
async def test_materialize_delete_returns_empty_content() -> None:
    async def read_file(path: str) -> str:
        return "gone\n"

    diff = """--- a/bye.py
+++ /dev/null
@@ -1 +0,0 @@
-gone
"""
    files = await materialize_unified_diff(diff, read_file=read_file)
    assert len(files) == 1
    assert files[0].path == "bye.py"
    assert files[0].content == ""
