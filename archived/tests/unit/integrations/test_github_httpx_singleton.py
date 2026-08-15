"""The shared GitHub httpx client must survive being used more than once.

``eden.integrations.github.oauth`` keeps a module-level AsyncClient so
the TCP pool stays warm across the four GitHub App calls that one OAuth
round-trip makes. But all eight call sites use it as
``async with _shared_httpx() as client:``, and ``AsyncClient.__aexit__``
calls ``aclose()``.

So the helper handed out the raw singleton, the first ``async with``
block closed it on exit, and every subsequent call raised

    RuntimeError: Cannot reopen a client instance, once it has been closed.

in ``__aenter__`` — before a request was even constructed. ``_HTTPX`` was
never reset to ``None``, so the entire GitHub App integration (OAuth
callback, installation token refresh, repo listing, PR operations) was
dead for the remaining life of the process. With four calls per OAuth
round-trip, the first customer to connect GitHub broke it on call two.
"""

from __future__ import annotations

import pytest

from eden.integrations.github import oauth


@pytest.fixture(autouse=True)
async def _reset_singleton():
    await oauth._close_shared_httpx()
    yield
    await oauth._close_shared_httpx()


class TestSharedHttpxClient:
    @pytest.mark.asyncio
    async def test_survives_repeated_context_manager_use(self):
        """Four uses, mirroring one OAuth round-trip."""
        seen = []
        for _ in range(4):
            async with oauth._shared_httpx() as client:
                assert not client.is_closed
                seen.append(client)
        # Still genuinely shared — the point of the singleton.
        assert all(c is seen[0] for c in seen)

    @pytest.mark.asyncio
    async def test_exiting_the_block_does_not_close_the_shared_client(self):
        async with oauth._shared_httpx() as client:
            pass
        assert not client.is_closed, (
            "scope exit closed the shared client; the next call will raise "
            "'Cannot reopen a client instance, once it has been closed'"
        )

    @pytest.mark.asyncio
    async def test_recovers_if_the_client_is_closed_out_of_band(self):
        """Belt and braces: a stray aclose() must not wedge the process."""
        async with oauth._shared_httpx() as client:
            pass
        await client.aclose()
        assert client.is_closed

        async with oauth._shared_httpx() as fresh:
            assert not fresh.is_closed
            assert fresh is not client

    @pytest.mark.asyncio
    async def test_close_helper_resets_the_singleton(self):
        async with oauth._shared_httpx() as first:
            pass
        await oauth._close_shared_httpx()
        assert oauth._HTTPX is None
        async with oauth._shared_httpx() as second:
            assert second is not first
            assert not second.is_closed

    def test_every_call_site_uses_the_context_manager(self):
        """If a call site ever switches to a bare call, the object it
        gets back is an async CM, not a client — fail loudly here."""
        import inspect

        src = inspect.getsource(oauth)
        bare = [
            line.strip()
            for line in src.splitlines()
            if "_shared_httpx()" in line
            and "async with" not in line
            and "def " not in line
            and not line.strip().startswith("#")
        ]
        assert not bare, f"_shared_httpx() must be used as a context manager: {bare}"
