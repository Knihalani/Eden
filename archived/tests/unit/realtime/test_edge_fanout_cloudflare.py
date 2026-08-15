"""S-10 CloudflareWorkersProvider init test.

The audit found that ``CloudflareWorkersProvider.__init__`` only
stored ``self._worker_url`` — ``self._api_token`` and
``self._account_id`` were never set. The first ``publish()`` raised
``AttributeError`` when ``_ensure_session`` tried to read them. The
fix wires the credentials through.

This test pins two contracts:

1. The constructor keeps ``api_token`` and ``account_id`` on the
   instance (so ``publish`` can build the Bearer header).
2. ``publish`` does NOT raise ``AttributeError`` on the credential
   path — it builds the session with the right ``Authorization``
   header.

Network I/O is patched out; we only assert the wiring.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest


def _make_provider():
    from eden.realtime.edge_fanout import CloudflareWorkersProvider

    return CloudflareWorkersProvider(
        worker_url="https://example.workers.dev/fanout",
        api_token="cf-token-abc",
        account_id="cf-account-xyz",
    )


class TestCloudflareWorkersProviderInit:
    def test_credentials_are_stored(self) -> None:
        provider = _make_provider()
        assert provider._api_token == "cf-token-abc"
        assert provider._account_id == "cf-account-xyz"

    def test_worker_url_is_stored(self) -> None:
        provider = _make_provider()
        assert provider._worker_url == "https://example.workers.dev/fanout"

    def test_missing_any_arg_raises_value_error(self) -> None:
        """The original ``if not (worker_url and api_token and account_id)``
        guard still rejects empty inputs.
        """
        from eden.realtime.edge_fanout import CloudflareWorkersProvider

        with pytest.raises(ValueError, match="worker_url, api_token, account_id"):
            CloudflareWorkersProvider(
                worker_url="",
                api_token="t",
                account_id="a",
            )
        with pytest.raises(ValueError, match="worker_url, api_token, account_id"):
            CloudflareWorkersProvider(
                worker_url="https://x",
                api_token="",
                account_id="a",
            )
        with pytest.raises(ValueError, match="worker_url, api_token, account_id"):
            CloudflareWorkersProvider(
                worker_url="https://x",
                api_token="t",
                account_id="",
            )


class TestCloudflareWorkersProviderPublish:
    @pytest.mark.asyncio
    async def test_publish_does_not_raise_attribute_error(self) -> None:
        """The pre-fix bug: first ``publish()`` raised
        ``AttributeError: 'CloudflareWorkersProvider' object has no
        attribute '_api_token'`` when ``_ensure_session`` tried to
        build the Authorization header. With the fix, publish runs
        cleanly.
        """
        provider = _make_provider()

        # Stub the aiohttp session + post so we don't hit the network.
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value="ok")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.closed = False

        # Patch the session builder so we don't talk to aiohttp.
        with patch.object(
            provider, "_ensure_session", AsyncMock(return_value=mock_session),
        ):
            ok = await provider.publish("channel-x", {"hello": "world"})

        assert ok is True
        mock_session.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_publish_passes_channel_and_event(self) -> None:
        provider = _make_provider()
        mock_response = MagicMock()
        mock_response.status = 200
        mock_response.text = AsyncMock(return_value="ok")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.closed = False

        with patch.object(
            provider, "_ensure_session", AsyncMock(return_value=mock_session),
        ):
            await provider.publish("my-channel", {"event": 1})

        # Inspect the kwargs to the post() call.
        kwargs = mock_session.post.call_args.kwargs
        assert kwargs["json"] == {
            "channel": "my-channel", "event": {"event": 1},
        }

    @pytest.mark.asyncio
    async def test_publish_returns_false_on_non_2xx(self) -> None:
        provider = _make_provider()
        mock_response = MagicMock()
        mock_response.status = 502
        mock_response.text = AsyncMock(return_value="upstream bad gateway")
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)

        mock_session = MagicMock()
        mock_session.post = MagicMock(return_value=mock_response)
        mock_session.closed = False

        with patch.object(
            provider, "_ensure_session", AsyncMock(return_value=mock_session),
        ):
            ok = await provider.publish("c", {"x": 1})

        assert ok is False
